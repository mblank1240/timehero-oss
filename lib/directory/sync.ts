/**
 * Applying a directory sync, and creating one employee from the directory at
 * sign-in. The decisions are `planDirectorySync` and `decideExternalSignIn`;
 * this reads, writes and audits.
 */

import type { Prisma } from '@prisma/client'

import { writeAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import type { JobOutcome } from '@/lib/jobs/runner'

import { planManagerChains } from './managers'
import { addressOf, employeeFromDirectoryUser, planDirectorySync, type DirectoryUser } from './plan'
import { directoryFor, type Directory } from './sources'

type Provider = 'MICROSOFT' | 'GOOGLE'

/**
 * Syncs every registered directory that can be read. A daily job, and the
 * "Sync now" button. `asOf` is the hire date given to anyone created whose
 * directory entry has none.
 */
export async function runDirectorySync(
  asOf: Date,
  opts: {
    actorId?: string | null
    directory?: (provider: Provider) => Promise<Directory>
  } = {},
): Promise<JobOutcome> {
  const connections = await db.directoryConnection.findMany({
    select: {
      id: true,
      provider: true,
      tenantId: true,
      domains: true,
      autoProvision: true,
      chainsFromManager: true,
    },
  })
  if (connections.length === 0) {
    return { entriesCreated: 0, detail: { connections: 0 } }
  }

  let created = 0
  const results: Record<string, unknown> = {}

  for (const connection of connections) {
    try {
      const directory = opts.directory
        ? await opts.directory(connection.provider)
        : await directoryFor(connection)
      // Domains first: one added to the tenant since the last sync should
      // count for this one.
      const domains = await directory.verifiedDomains()
      if (domains.length > 0 && domains.join() !== connection.domains.join()) {
        await db.directoryConnection.update({
          where: { id: connection.id },
          data: { domains },
        })
        connection.domains = domains
      }
      const outcome = await syncOne(
        connection,
        await directory.listUsers(),
        asOf,
        opts.actorId ?? null,
      )
      created += outcome.created
      results[connection.provider] = outcome
      await db.directoryConnection.update({
        where: { id: connection.id },
        data: {
          lastSyncAt: new Date(),
          lastSyncDetail: outcome as Prisma.InputJsonValue,
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      results[connection.provider] = { error: message }
      await db.directoryConnection.update({
        where: { id: connection.id },
        data: { lastSyncAt: new Date(), lastSyncDetail: { error: message } },
      })
    }
  }

  const failed = Object.values(results).filter((r) => (r as { error?: string }).error)
  if (failed.length === connections.length) {
    throw new Error(
      `Directory sync failed: ${failed.map((f) => (f as { error: string }).error).join('; ')}`,
    )
  }
  return { entriesCreated: created, detail: results }
}

async function syncOne(
  connection: {
    provider: Provider
    tenantId: string
    domains: string[]
    autoProvision: boolean
    chainsFromManager: boolean
  },
  users: DirectoryUser[],
  asOf: Date,
  actorId: string | null,
) {
  const employees = await db.employee.findMany({
    select: {
      id: true,
      email: true,
      isActive: true,
      identities: {
        // This tenant's accounts only: whether one is missing is a question
        // only this directory can answer.
        where: {
          provider: connection.provider,
          OR: [{ tenant: connection.tenantId }, { tenant: null }],
        },
        select: { subject: true },
      },
    },
  })
  const plan = planDirectorySync({
    users,
    employees: employees.map((e) => ({
      id: e.id,
      email: e.email,
      isActive: e.isActive,
      subjects: e.identities.map((i) => i.subject),
    })),
    domains: connection.domains,
    autoProvision: connection.autoProvision,
  })

  let managers = { chainsPrefilled: 0, flaggedManagerChanged: 0 }
  await db.$transaction(async (tx) => {
    for (const { employeeId, user } of plan.link) {
      await tx.identity.create({
        data: identityData(connection, user, employeeId),
      })
    }
    for (const user of plan.create) {
      const employee = await tx.employee.create({
        data: employeeFromDirectoryUser(user, asOf),
      })
      await tx.identity.create({
        data: identityData(connection, user, employee.id),
      })
      await writeAudit(
        {
          actorId,
          action: 'employee.createFromDirectory',
          entityType: 'Employee',
          entityId: employee.id,
          after: {
            email: employee.email,
            provider: connection.provider,
            subject: user.id,
          },
        },
        tx,
      )
    }
    // Before the refresh below records this sync's managers: the change from
    // the last one is what flags a chain.
    if (connection.chainsFromManager) {
      managers = await applyManagerChains(tx, connection.provider, users, actorId)
    }

    for (const r of plan.refresh) {
      await tx.identity.update({
        where: {
          provider_subject: {
            provider: connection.provider,
            subject: r.subject,
          },
        },
        data: {
          directoryAccountEnabled: r.enabled,
          email: r.email,
          directoryManagerSubject: r.managerSubject,
        },
      })
    }
    // Audited once, on the sync that first finds the account gone; the flag is
    // set again each sync until someone acts, as for a disabled account.
    const newlyMissing = new Set(
      (
        await tx.identity.findMany({
          where: {
            provider: connection.provider,
            subject: { in: plan.missing },
            // Null too: an account linked at sign-in and gone before a sync saw it.
            OR: [{ directoryAccountEnabled: true }, { directoryAccountEnabled: null }],
          },
          select: { employeeId: true },
        })
      ).map((i) => i.employeeId),
    )
    if (plan.missing.length > 0) {
      // Recorded as disabled, which is what stops every way of signing in.
      await tx.identity.updateMany({
        where: { provider: connection.provider, subject: { in: plan.missing } },
        data: { directoryAccountEnabled: false },
      })
    }
    if (plan.flagMissing.length > 0) {
      await tx.employee.updateMany({
        where: { id: { in: plan.flagMissing } },
        data: { needsReview: true },
      })
      for (const employeeId of plan.flagMissing.filter((id) => newlyMissing.has(id))) {
        await writeAudit(
          {
            actorId,
            action: 'employee.flagDirectoryMissing',
            entityType: 'Employee',
            entityId: employeeId,
          },
          tx,
        )
      }
    }
    if (plan.flagDisabled.length > 0) {
      await tx.employee.updateMany({
        where: { id: { in: plan.flagDisabled } },
        data: { needsReview: true },
      })
    }
  })

  const outcome = {
    created: plan.create.length,
    linked: plan.link.length,
    flaggedDisabled: plan.flagDisabled.length,
    flaggedMissing: plan.flagMissing.length,
    missingWithheld: plan.missingWithheld,
    ...managers,
    alreadyBound: plan.refresh.length,
    skipped: plan.skipped,
  }
  await writeAudit({
    actorId,
    action: 'directory.sync',
    entityType: 'DirectoryConnection',
    entityId: connection.provider,
    after: outcome,
  })
  return outcome
}

function identityData(
  connection: { provider: Provider; tenantId: string },
  user: DirectoryUser,
  employeeId: string,
) {
  return {
    employeeId,
    provider: connection.provider,
    subject: user.id,
    tenant: connection.tenantId,
    email: addressOf(user),
    directoryAccountEnabled: user.accountEnabled,
    directoryManagerSubject: user.managerId,
  }
}

/**
 * Starts empty approval chains with the directory manager and flags employees
 * whose manager has changed (`planManagerChains`). Reads the identities as
 * they stand inside the sync's transaction, so an employee and their manager
 * created by this same sync are matched.
 */
async function applyManagerChains(
  tx: Prisma.TransactionClient,
  provider: Provider,
  users: readonly DirectoryUser[],
  actorId: string | null,
) {
  const listed = new Map(users.map((u) => [u.id, u]))
  const bound = await tx.identity.findMany({
    where: { provider },
    select: {
      subject: true,
      directoryManagerSubject: true,
      employee: {
        select: {
          id: true,
          isActive: true,
          approvalChain: { orderBy: { step: 'asc' }, select: { approverId: true } },
        },
      },
    },
  })

  const plan = planManagerChains(
    bound
      .filter((b) => listed.has(b.subject))
      .map((b) => ({
        employeeId: b.employee.id,
        isActive: b.employee.isActive,
        managerSubject: listed.get(b.subject)!.managerId,
        previousManagerSubject: b.directoryManagerSubject,
        chain: b.employee.approvalChain.map((s) => s.approverId),
      })),
    new Map(bound.map((b) => [b.subject, { id: b.employee.id, isActive: b.employee.isActive }])),
  )

  let prefilled = 0
  for (const p of plan.prefill) {
    // A chain set by hand since the read above wins: its step 1 is taken.
    const { count } = await tx.approvalChainStep.createMany({
      data: [{ employeeId: p.employeeId, step: 1, approverId: p.approverId }],
      skipDuplicates: true,
    })
    if (count === 0) continue
    prefilled += 1
    await writeAudit(
      {
        actorId,
        action: 'approvalChain.fromDirectoryManager',
        entityType: 'Employee',
        entityId: p.employeeId,
        before: [],
        after: [{ step: 1, approverId: p.approverId }],
      },
      tx,
    )
  }
  if (plan.flag.length > 0) {
    await tx.employee.updateMany({ where: { id: { in: plan.flag } }, data: { needsReview: true } })
    for (const employeeId of plan.flag) {
      await writeAudit(
        {
          actorId,
          action: 'employee.flagManagerChanged',
          entityType: 'Employee',
          entityId: employeeId,
        },
        tx,
      )
    }
  }
  return { chainsPrefilled: prefilled, flaggedManagerChanged: plan.flag.length }
}

/**
 * Creates the employee for someone signing in from the organization's
 * Microsoft tenant who has none — after asking the directory that their
 * account is real, enabled, a member and in the organization's domains.
 * Returns null when it is not.
 */
export async function provisionFromDirectory(args: {
  connection: { provider: Provider; tenantId: string; domains: string[] }
  subject: string
  directory?: Directory
  now?: Date
}): Promise<string | null> {
  const directory = args.directory ?? (await directoryFor(args.connection))
  const user = await directory.getUser(args.subject)
  if (!user) return null

  const plan = planDirectorySync({
    users: [user],
    employees: [],
    domains: args.connection.domains,
    autoProvision: true,
  })
  if (plan.create.length !== 1) return null

  const today = args.now ?? new Date()
  return db.$transaction(async (tx) => {
    // The address may have been taken since the sign-in decision was made.
    const existing = await tx.employee.findUnique({
      where: { email: addressOf(user) },
    })
    if (existing) return null
    const employee = await tx.employee.create({
      data: employeeFromDirectoryUser(user, today),
    })
    await tx.identity.create({
      data: identityData(args.connection, user, employee.id),
    })
    await writeAudit(
      {
        actorId: null,
        action: 'employee.createFromDirectory',
        entityType: 'Employee',
        entityId: employee.id,
        after: {
          email: employee.email,
          provider: args.connection.provider,
          at: 'sign-in',
        },
      },
      tx,
    )
    return employee.id
  })
}
