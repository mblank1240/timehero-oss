import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db } from '@/lib/db'
import type { DirectoryUser } from '@/lib/directory/plan'
import { resolveExternalSignIn } from '@/lib/directory/sign-in'
import type { Directory } from '@/lib/directory/sources'
import { runDirectorySync } from '@/lib/directory/sync'
import { env } from '@/lib/env'
import {
  MAX_LINKS_SENT_PER_HOUR,
  MAX_REQUESTS_PER_ADDRESS_PER_HOUR,
  consumeSignInLink,
  emailLinksAvailable,
  hashToken,
  newToken,
  requestSignInLink,
} from '@/lib/sign-in-links'

/**
 * Signing in without a password against real Postgres: emailed links, the
 * rules for Microsoft and Google accounts, and the directory sync — with a
 * fake directory standing in for Microsoft Graph.
 *
 * The Microsoft connection is a singleton, so this file refuses to run if
 * one already exists rather than overwrite a real one. Everything is
 * namespaced by a run id, including the organization's domain.
 */

const RUN = `sitest-${Date.now().toString(36)}`
const DOMAIN = `${RUN}.example.test`
const TENANT = `tenant-${RUN}`
const employeeIds: string[] = []

async function person(key: string, opts: { isActive?: boolean; terminationDate?: Date } = {}) {
  const employee = await db.employee.create({
    data: {
      email: `${key}@${DOMAIN}`,
      firstName: RUN,
      lastName: key,
      employmentType: 'HOURLY',
      hireDate: new Date('2020-01-01'),
      isActive: opts.isActive ?? true,
      terminationDate: opts.terminationDate ?? null,
    },
  })
  employeeIds.push(employee.id)
  return employee
}

/** The token from the newest message sent to `to`, from the file transport. */
async function tokenMailedTo(to: string): Promise<string | null> {
  const dir = path.resolve(env.MAIL_FILE_DIR)
  const files = (await readdir(dir).catch(() => [])).sort().reverse()
  for (const file of files) {
    const mail = JSON.parse(await readFile(path.join(dir, file), 'utf8')) as {
      to: string
      text: string
    }
    if (mail.to === to) return /token=([A-Za-z0-9_-]+)/.exec(mail.text)?.[1] ?? null
  }
  return null
}

/**
 * Asks for a link and waits for the message. Outside a request there is no
 * `after()`, so the send runs here instead of once a response has gone.
 */
async function request(args: Parameters<typeof requestSignInLink>[0]) {
  const sending: Promise<void>[] = []
  const outcome = await requestSignInLink({ ...args, defer: (task) => sending.push(task()) })
  await Promise.all(sending)
  return outcome
}

function directoryOf(users: DirectoryUser[], domains = [DOMAIN]): Directory {
  return {
    listUsers: async () => users,
    getUser: async (id) => users.find((u) => u.id === id) ?? null,
    verifiedDomains: async () => domains,
  }
}

function user(id: string, local: string, overrides: Partial<DirectoryUser> = {}): DirectoryUser {
  return {
    id,
    displayName: `${RUN} ${local}`,
    givenName: RUN,
    surname: local,
    mail: `${local}@${DOMAIN}`,
    userPrincipalName: `${local}@${DOMAIN}`,
    accountEnabled: true,
    userType: 'Member',
    employeeHireDate: null,
    managerId: null,
    ...overrides,
  }
}

beforeAll(async () => {
  if (await db.directoryConnection.findUnique({ where: { provider: 'MICROSOFT' } })) {
    throw new Error('A Microsoft directory is already connected; refusing to replace it in a test.')
  }
})

afterAll(async () => {
  const all = await db.employee.findMany({
    where: { email: { endsWith: `@${DOMAIN}` } },
    select: { id: true },
  })
  const ids = [...new Set([...employeeIds, ...all.map((e) => e.id)])]
  await db.auditLog.deleteMany({
    where: { OR: [{ entityId: { in: ids } }, { action: 'directory.sync', entityId: 'MICROSOFT' }] },
  })
  await db.approvalChainStep.deleteMany({
    where: { OR: [{ employeeId: { in: ids } }, { approverId: { in: ids } }] },
  })
  await db.signInLinkRequest.deleteMany({ where: { email: { contains: RUN } } })
  await db.directoryConnection.deleteMany({ where: { tenantId: TENANT } })
  await db.employee.deleteMany({ where: { id: { in: ids } } })
})

describe('emailed sign-in links', () => {
  it('sends a single-use link to an employee who may sign in', async () => {
    const sam = await person('sam')
    expect(await request({ email: ` SAM@${DOMAIN} `, ipAddress: '203.0.113.1' })).toBe(
      'SENT_IF_KNOWN',
    )

    const token = await tokenMailedTo(sam.email)
    expect(token).not.toBeNull()

    // Only the hash is stored.
    const stored = await db.signInLinkRequest.findFirstOrThrow({
      where: { email: sam.email },
      select: { tokenHash: true, employeeId: true },
    })
    expect(stored.employeeId).toBe(sam.id)
    expect(stored.tokenHash).not.toContain(token!)

    expect(await consumeSignInLink(token!)).toMatchObject({ id: sam.id })
    expect(await consumeSignInLink(token!)).toBeNull()
  })

  it('says the same thing for an unknown address, and sends nothing', async () => {
    const email = `nobody@${DOMAIN}`
    expect(await request({ email, ipAddress: '203.0.113.2' })).toBe('SENT_IF_KNOWN')
    expect(await tokenMailedTo(email)).toBeNull()
    const row = await db.signInLinkRequest.findFirstOrThrow({ where: { email } })
    expect(row.tokenHash).toBeNull()
  })

  it('sends nothing to someone who may not sign in', async () => {
    const gone = await person('gone', { isActive: false })
    await request({ email: gone.email, ipAddress: null })
    expect(await tokenMailedTo(gone.email)).toBeNull()
  })

  it('refuses an expired link, or one whose employee has since left', async () => {
    const pat = await person('pat')
    await request({
      email: pat.email,
      ipAddress: null,
      now: new Date(Date.now() - 3_600_000),
    })
    expect(await consumeSignInLink((await tokenMailedTo(pat.email))!)).toBeNull()

    const lee = await person('lee')
    await request({ email: lee.email, ipAddress: null })
    const token = (await tokenMailedTo(lee.email))!
    await db.employee.update({ where: { id: lee.id }, data: { isActive: false } })
    expect(await consumeSignInLink(token)).toBeNull()
  })

  it('offers nothing, and sends nothing, without a sending address', async () => {
    const noAddress = await person('no-address')
    const { mailFromAddress } = await db.orgSettings.findUniqueOrThrow({ where: { id: 1 } })
    await db.orgSettings.update({ where: { id: 1 }, data: { mailFromAddress: null } })
    try {
      expect(await emailLinksAvailable()).toBe(false)
      expect(await request({ email: noAddress.email, ipAddress: null })).toBe(
        'UNAVAILABLE',
      )
      expect(await tokenMailedTo(noAddress.email)).toBeNull()
      expect(await db.signInLinkRequest.count({ where: { email: noAddress.email } })).toBe(0)
    } finally {
      await db.orgSettings.update({ where: { id: 1 }, data: { mailFromAddress } })
    }
    expect(await emailLinksAvailable()).toBe(true)
  })

  it('limits requests per address, whether or not it exists', async () => {
    const email = `limited@${DOMAIN}`
    for (let i = 0; i < MAX_REQUESTS_PER_ADDRESS_PER_HOUR; i += 1) {
      expect(await request({ email, ipAddress: null })).toBe('SENT_IF_KNOWN')
    }
    expect(await request({ email, ipAddress: null })).toBe('RATE_LIMITED')
  })

  it('limits the links mailed in an hour across everyone, for every address alike', async () => {
    const ari = await person('ari')
    const since = new Date(Date.now() - 3_600_000)
    const sent = await db.signInLinkRequest.count({
      where: { tokenHash: { not: null }, createdAt: { gte: since } },
    })
    const flood = `flood@${DOMAIN}`
    await db.signInLinkRequest.createMany({
      data: Array.from({ length: Math.max(0, MAX_LINKS_SENT_PER_HOUR - sent) }, () => ({
        email: flood,
        employeeId: ari.id,
        tokenHash: hashToken(newToken()),
        expiresAt: new Date(Date.now() + 60_000),
      })),
    })
    try {
      expect(await request({ email: ari.email, ipAddress: '203.0.113.9' })).toBe('RATE_LIMITED')
      expect(await tokenMailedTo(ari.email)).toBeNull()
      expect(await request({ email: `nobody-else@${DOMAIN}`, ipAddress: '203.0.113.9' })).toBe(
        'RATE_LIMITED',
      )
    } finally {
      await db.signInLinkRequest.deleteMany({ where: { email: flood } })
    }
    expect(await request({ email: ari.email, ipAddress: '203.0.113.9' })).toBe('SENT_IF_KNOWN')
  })
})

describe('Google sign-in with no Workspace registered', () => {
  it('links nobody by address, so a personal account on a work address gets nowhere', async () => {
    const casey = await person('casey')
    const signIn = {
      provider: 'GOOGLE' as const,
      subject: `${RUN}-casey`,
      tenant: null,
      email: casey.email,
      emailVerified: true,
    }
    expect(await resolveExternalSignIn(signIn)).toEqual({ ok: false, refusal: 'UntrustedTenant' })
    expect(await db.identity.count({ where: { employeeId: casey.id } })).toBe(0)

    // A Google account bound earlier — by an administrator, say — still gets in.
    await db.identity.create({
      data: { employeeId: casey.id, provider: 'GOOGLE', subject: signIn.subject },
    })
    expect(await resolveExternalSignIn(signIn)).toEqual({ ok: true, employeeId: casey.id })
  })
})

describe('Microsoft sign-in with a registered directory', () => {
  beforeAll(async () => {
    await db.directoryConnection.create({
      data: { provider: 'MICROSOFT', tenantId: TENANT, domains: [DOMAIN], autoProvision: true },
    })
  })

  it('links an existing employee by address on the first sign-in, then by account', async () => {
    const dana = await person('dana')
    const signIn = {
      provider: 'MICROSOFT' as const,
      subject: `${RUN}-dana`,
      tenant: TENANT,
      email: dana.email,
      emailVerified: true,
    }
    expect(await resolveExternalSignIn(signIn)).toEqual({ ok: true, employeeId: dana.id })
    expect(await db.identity.count({ where: { employeeId: dana.id } })).toBe(1)

    // The mailbox is renamed; the bound account still gets in.
    expect(await resolveExternalSignIn({ ...signIn, email: `dana.w@${DOMAIN}` })).toEqual({
      ok: true,
      employeeId: dana.id,
    })
  })

  it('refuses another tenant', async () => {
    const robin = await person('robin')
    expect(
      await resolveExternalSignIn({
        provider: 'MICROSOFT',
        subject: `${RUN}-intruder`,
        tenant: 'another-tenant',
        email: robin.email,
        emailVerified: true,
      }),
    ).toEqual({ ok: false, refusal: 'WrongTenant' })
  })

  it('creates someone from the directory on their first sign-in, marked for review', async () => {
    const directory = directoryOf([user(`${RUN}-new`, 'newhire')])
    const resolved = await resolveExternalSignIn(
      {
        provider: 'MICROSOFT',
        subject: `${RUN}-new`,
        tenant: TENANT,
        email: `newhire@${DOMAIN}`,
        emailVerified: true,
      },
      { directory },
    )
    expect(resolved.ok).toBe(true)
    const created = await db.employee.findUniqueOrThrow({
      where: { email: `newhire@${DOMAIN}` },
      select: { needsReview: true, employmentType: true, payScheduleId: true },
    })
    expect(created).toEqual({ needsReview: true, employmentType: 'HOURLY', payScheduleId: null })
  })

  it('does not create someone the directory says is disabled', async () => {
    const directory = directoryOf([user(`${RUN}-off`, 'off', { accountEnabled: false })])
    expect(
      await resolveExternalSignIn(
        {
          provider: 'MICROSOFT',
          subject: `${RUN}-off`,
          tenant: TENANT,
          email: `off@${DOMAIN}`,
          emailVerified: true,
        },
        { directory },
      ),
    ).toEqual({ ok: false, refusal: 'NotLinked' })
  })
})

describe('the directory sync', () => {
  it('imports, links and flags, and a second run changes nothing', async () => {
    const jess = await person('jess')
    const kim = await person('kim')
    await db.identity.create({
      data: { employeeId: kim.id, provider: 'MICROSOFT', subject: `${RUN}-kim`, tenant: TENANT },
    })

    const users = [
      user(`${RUN}-jess`, 'jess'),
      user(`${RUN}-kim`, 'kim', { accountEnabled: false }),
      user(`${RUN}-alex`, 'alex', { employeeHireDate: '2025-03-03T00:00:00Z' }),
      user(`${RUN}-guest`, 'guest', { userType: 'Guest' }),
    ]
    const result = await runDirectorySync(new Date('2026-10-07T00:00:00Z'), {
      directory: async () => directoryOf(users, [DOMAIN, `extra-${DOMAIN}`]),
    })

    expect(result.detail?.MICROSOFT).toMatchObject({ created: 1, linked: 1, flaggedDisabled: 1 })
    expect(await db.identity.count({ where: { employeeId: jess.id } })).toBe(1)
    expect((await db.employee.findUniqueOrThrow({ where: { id: kim.id } })).needsReview).toBe(true)

    // Flagged, not deactivated — but not signed in by any route meanwhile.
    expect(
      await resolveExternalSignIn({
        provider: 'MICROSOFT',
        subject: `${RUN}-kim`,
        tenant: TENANT,
        email: kim.email,
        emailVerified: true,
      }),
    ).toEqual({ ok: false, refusal: 'DirectoryDisabled' })
    expect(await request({ email: kim.email, ipAddress: '203.0.113.3' })).toBe('SENT_IF_KNOWN')
    expect(await tokenMailedTo(kim.email)).toBeNull()
    const alex = await db.employee.findUniqueOrThrow({ where: { email: `alex@${DOMAIN}` } })
    expect(alex.hireDate).toEqual(new Date('2025-03-03T00:00:00Z'))

    // The tenant gained a domain; the connection follows it.
    const connection = await db.directoryConnection.findUniqueOrThrow({
      where: { provider: 'MICROSOFT' },
    })
    expect(connection.domains).toEqual([DOMAIN, `extra-${DOMAIN}`])
    expect(connection.lastSyncAt).not.toBeNull()

    const again = await runDirectorySync(new Date('2026-10-08T00:00:00Z'), {
      directory: async () => directoryOf(users, [DOMAIN, `extra-${DOMAIN}`]),
    })
    expect(again.detail?.MICROSOFT).toMatchObject({ created: 0, linked: 0 })
  })

  it('starts an empty approval chain with the manager, then flags a new manager', async () => {
    const pat = await person('mgr-pat')
    await person('mgr-lin')
    const sam = await person('mgr-sam')
    const users = (manager: string) => [
      user(`${RUN}-mgr-pat`, 'mgr-pat'),
      user(`${RUN}-mgr-lin`, 'mgr-lin'),
      user(`${RUN}-mgr-sam`, 'mgr-sam', { managerId: `${RUN}-mgr-${manager}` }),
    ]
    const chainOf = async (employeeId: string) =>
      (await db.approvalChainStep.findMany({ where: { employeeId }, orderBy: { step: 'asc' } })).map(
        (s) => s.approverId,
      )

    const first = await runDirectorySync(new Date('2026-10-09T00:00:00Z'), {
      directory: async () => directoryOf(users('pat')),
    })
    expect(first.detail?.MICROSOFT).toMatchObject({ chainsPrefilled: 1, flaggedManagerChanged: 0 })
    expect(await chainOf(sam.id)).toEqual([pat.id])
    expect(await chainOf(pat.id)).toEqual([])

    // An administrator reviewed Sam; then the directory moves them to Lin.
    await db.employee.update({ where: { id: sam.id }, data: { needsReview: false } })
    const moved = await runDirectorySync(new Date('2026-10-10T00:00:00Z'), {
      directory: async () => directoryOf(users('lin')),
    })
    expect(moved.detail?.MICROSOFT).toMatchObject({ chainsPrefilled: 0, flaggedManagerChanged: 1 })
    // Flagged, never rewritten.
    expect(await chainOf(sam.id)).toEqual([pat.id])
    expect((await db.employee.findUniqueOrThrow({ where: { id: sam.id } })).needsReview).toBe(true)

    // Nothing has changed since, so the next sync flags nothing more.
    await db.employee.update({ where: { id: sam.id }, data: { needsReview: false } })
    const same = await runDirectorySync(new Date('2026-10-11T00:00:00Z'), {
      directory: async () => directoryOf(users('lin')),
    })
    expect(same.detail?.MICROSOFT).toMatchObject({ chainsPrefilled: 0, flaggedManagerChanged: 0 })
  })

  it('blocks and flags someone whose account is deleted, and lets them back if it returns', async () => {
    const gone = await person('deleted')
    await db.identity.create({
      data: {
        employeeId: gone.id,
        provider: 'MICROSOFT',
        subject: `${RUN}-deleted`,
        tenant: TENANT,
        email: gone.email,
        directoryAccountEnabled: true,
      },
    })
    // Everyone this tenant has bound so far, as the directory lists them; the
    // earlier tests here bound several, and a listing missing most of them
    // would be withheld.
    const everyone = async () =>
      (
        await db.identity.findMany({
          where: { tenant: TENANT },
          select: { subject: true, email: true, directoryAccountEnabled: true },
        })
      ).map((i) =>
        user(i.subject, (i.email ?? i.subject).split('@')[0], {
          accountEnabled: i.directoryAccountEnabled !== false,
        }),
      )
    const signIn = () =>
      resolveExternalSignIn({
        provider: 'MICROSOFT',
        subject: `${RUN}-deleted`,
        tenant: TENANT,
        email: gone.email,
        emailVerified: true,
      })
    const listing = await everyone()
    const without = listing.filter((u) => u.id !== `${RUN}-deleted`)

    const first = await runDirectorySync(new Date('2026-10-12T00:00:00Z'), {
      directory: async () => directoryOf(without),
    })
    expect(first.detail?.MICROSOFT).toMatchObject({ flaggedMissing: 1, missingWithheld: 0 })
    expect((await db.employee.findUniqueOrThrow({ where: { id: gone.id } })).needsReview).toBe(true)
    expect(await signIn()).toEqual({ ok: false, refusal: 'DirectoryDisabled' })
    // Nor by emailed link — the address may now reach someone else's mailbox.
    expect(await request({ email: gone.email, ipAddress: '203.0.113.9' })).toBe('SENT_IF_KNOWN')
    expect(await tokenMailedTo(gone.email)).toBeNull()

    // Still gone the next day: flagged again, audited once.
    await runDirectorySync(new Date('2026-10-13T00:00:00Z'), {
      directory: async () => directoryOf(without),
    })
    expect(
      await db.auditLog.count({
        where: { entityId: gone.id, action: 'employee.flagDirectoryMissing' },
      }),
    ).toBe(1)

    // Restored from the recycle bin: the refresh sees it enabled again.
    await runDirectorySync(new Date('2026-10-14T00:00:00Z'), {
      directory: async () => directoryOf(listing),
    })
    expect((await signIn()).ok).toBe(true)
  })
})
