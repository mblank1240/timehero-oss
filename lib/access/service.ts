/**
 * Access roles: saving and deleting them, and the rule that keeps the
 * organization from locking itself out — someone who can sign in must always
 * hold `MANAGE_ACCESS`. Every write that could break that runs the check
 * inside its own transaction, after the write, so a breaking change rolls back
 * whatever path it came by.
 */

import type { Prisma } from '@prisma/client'

import { writeAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import { holdersWhere } from '@/lib/permissions'

import type { AccessRoleInput } from './schema'

type Tx = Prisma.TransactionClient

export class AccessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AccessError'
  }
}

/** Throws unless at least one employee who can sign in may manage access. */
export async function assertSomeoneManagesAccess(tx: Tx, now: Date = new Date()): Promise<void> {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const holders = await tx.employee.count({
    where: {
      ...holdersWhere(['MANAGE_ACCESS']),
      isActive: true,
      OR: [{ terminationDate: null }, { terminationDate: { gte: today } }],
      identities: { none: { directoryAccountEnabled: false } },
    },
  })
  if (holders === 0) {
    throw new AccessError(
      'That would leave nobody able to manage access. Give someone else a role with “Manage access” first.',
    )
  }
}

export async function saveAccessRole(
  actorId: string,
  id: string | null,
  input: AccessRoleInput,
): Promise<{ id: string }> {
  return db.$transaction(async (tx) => {
    const before = id ? await tx.accessRole.findUnique({ where: { id } }) : null
    if (id && !before) throw new AccessError('That access role no longer exists.')
    if (before?.allPermissions) {
      throw new AccessError('The Administrator role always holds every permission and cannot be edited.')
    }

    const data = {
      name: input.name,
      description: input.description,
      permissions: input.permissions,
    }
    const after = id
      ? await tx.accessRole.update({ where: { id }, data })
      : await tx.accessRole.create({ data })

    await assertSomeoneManagesAccess(tx)
    await writeAudit(
      {
        actorId,
        action: id ? 'accessRole.update' : 'accessRole.create',
        entityType: 'AccessRole',
        entityId: after.id,
        before: before ? pick(before) : undefined,
        after: data,
      },
      tx,
    )
    return { id: after.id }
  })
}

export async function deleteAccessRole(actorId: string, id: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const role = await tx.accessRole.findUnique({
      where: { id },
      include: { _count: { select: { employees: true } } },
    })
    if (!role) return
    if (role.allPermissions) throw new AccessError('The Administrator role cannot be deleted.')
    if (role._count.employees > 0) {
      throw new AccessError('People still hold this role. Give them another one first.')
    }
    await tx.accessRole.delete({ where: { id } })
    await writeAudit(
      {
        actorId,
        action: 'accessRole.delete',
        entityType: 'AccessRole',
        entityId: id,
        before: pick(role),
      },
      tx,
    )
  })
}

function pick(role: { name: string; description: string; permissions: string[] }) {
  return { name: role.name, description: role.description, permissions: role.permissions }
}
