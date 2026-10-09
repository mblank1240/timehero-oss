import { db } from '@/lib/db'
import { effectivePermissions, type Permission } from '@/lib/permissions'

/**
 * The access roles the migrations create, by the names the tests used before
 * there were access roles: ADMIN is the built-in Administrator, FINANCE the
 * role called Finance, EMPLOYEE none.
 */
type Legacy = 'ADMIN' | 'FINANCE' | 'EMPLOYEE'

async function roleOf(legacy: Legacy | undefined) {
  if (legacy === 'ADMIN') return db.accessRole.findFirstOrThrow({ where: { allPermissions: true } })
  if (legacy === 'FINANCE') return db.accessRole.findUniqueOrThrow({ where: { name: 'Finance' } })
  return null
}

export async function accessRoleId(legacy: Legacy | undefined): Promise<string | null> {
  return (await roleOf(legacy))?.id ?? null
}

export async function permissionsFor(legacy: Legacy | undefined): Promise<Permission[]> {
  return effectivePermissions(await roleOf(legacy))
}
