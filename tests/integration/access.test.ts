import { afterAll, describe, expect, it } from 'vitest'

import { AccessError, assertSomeoneManagesAccess, deleteAccessRole, saveAccessRole } from '@/lib/access/service'
import { db } from '@/lib/db'
import { holdersWhere } from '@/lib/permissions'

/**
 * Access roles against real Postgres: saving and deleting them, and the rule
 * that someone who can sign in always holds "Manage access". The seeded
 * administrators hold it through the built-in Administrator role, so the
 * lockout is exercised inside a transaction that the check itself rolls back.
 */

const RUN = `actest-${Date.now().toString(36)}`
const roleIds: string[] = []
const employeeIds: string[] = []

afterAll(async () => {
  await db.employee.deleteMany({ where: { id: { in: employeeIds } } })
  await db.auditLog.deleteMany({ where: { entityId: { in: roleIds } } })
  await db.accessRole.deleteMany({ where: { id: { in: roleIds } } })
})

async function actorId(): Promise<string> {
  return (await db.employee.findFirstOrThrow({ where: holdersWhere(['MANAGE_ACCESS']) })).id
}

describe('access roles', () => {
  it('creates, edits and deletes a role, auditing each', async () => {
    const actor = await actorId()
    const { id } = await saveAccessRole(actor, null, {
      name: `${RUN} Developer`,
      description: '',
      permissions: ['MANAGE_JOBS', 'MANAGE_DIRECTORY'],
    })
    roleIds.push(id)
    await saveAccessRole(actor, id, {
      name: `${RUN} Developer`,
      description: 'Keeps the lights on',
      permissions: ['MANAGE_JOBS', 'MANAGE_DIRECTORY', 'MANAGE_SETTINGS'],
    })
    expect((await db.accessRole.findUniqueOrThrow({ where: { id } })).permissions).toEqual([
      'MANAGE_JOBS',
      'MANAGE_DIRECTORY',
      'MANAGE_SETTINGS',
    ])

    await deleteAccessRole(actor, id)
    expect(await db.accessRole.findUnique({ where: { id } })).toBeNull()
    expect(
      (await db.auditLog.findMany({ where: { entityId: id }, orderBy: { createdAt: 'asc' } })).map(
        (a) => a.action,
      ),
    ).toEqual(['accessRole.create', 'accessRole.update', 'accessRole.delete'])
  })

  it('will not edit or delete Administrator', async () => {
    const actor = await actorId()
    const administrator = await db.accessRole.findFirstOrThrow({ where: { allPermissions: true } })
    await expect(
      saveAccessRole(actor, administrator.id, { name: 'Admin', description: '', permissions: [] }),
    ).rejects.toThrow(AccessError)
    await expect(deleteAccessRole(actor, administrator.id)).rejects.toThrow(AccessError)
  })

  it('will not delete a role somebody holds', async () => {
    const actor = await actorId()
    const { id } = await saveAccessRole(actor, null, {
      name: `${RUN} Held`,
      description: '',
      permissions: ['REPORT_LEAVE'],
    })
    roleIds.push(id)
    const holder = await db.employee.create({
      data: {
        email: `${RUN}-holder@example.test`,
        firstName: RUN,
        lastName: 'holder',
        employmentType: 'HOURLY',
        hireDate: new Date('2020-01-01'),
        accessRoleId: id,
      },
    })
    employeeIds.push(holder.id)
    await expect(deleteAccessRole(actor, id)).rejects.toThrow(/still hold/)
  })
})

describe('nobody is locked out', () => {
  it('passes while someone who can sign in manages access', async () => {
    await expect(db.$transaction((tx) => assertSomeoneManagesAccess(tx))).resolves.toBeUndefined()
  })

  it('refuses, and rolls back, a change that leaves nobody managing access', async () => {
    const holders = await db.employee.count({
      where: { ...holdersWhere(['MANAGE_ACCESS']), isActive: true },
    })
    await expect(
      db.$transaction(async (tx) => {
        await tx.employee.updateMany({
          where: holdersWhere(['MANAGE_ACCESS']),
          data: { isActive: false },
        })
        await assertSomeoneManagesAccess(tx)
      }),
    ).rejects.toThrow(AccessError)
    expect(
      await db.employee.count({ where: { ...holdersWhere(['MANAGE_ACCESS']), isActive: true } }),
    ).toBe(holders)
  })

  it('does not count someone whose termination date has passed', async () => {
    await expect(
      db.$transaction(async (tx) => {
        await tx.employee.updateMany({
          where: holdersWhere(['MANAGE_ACCESS']),
          data: { terminationDate: new Date('2020-01-01') },
        })
        await assertSomeoneManagesAccess(tx, new Date('2026-10-09T12:00:00Z'))
      }),
    ).rejects.toThrow(AccessError)
  })
})
