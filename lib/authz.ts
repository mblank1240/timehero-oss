import { redirect } from 'next/navigation'
import { cache } from 'react'

import { can, canAny, effectivePermissions, type Permission } from '@/lib/permissions'

import { auth } from './auth'
import { db } from './db'
import { disabledInDirectory } from './directory/link'
import { resolveEmployeeForSignIn } from './sign-in'

export { can, canAny }

export class ForbiddenError extends Error {
  constructor(message = 'Forbidden') {
    super(message)
    this.name = 'ForbiddenError'
  }
}

export type CurrentUser = {
  id: string
  email: string
  firstName: string
  lastName: string
  /** Everything their access role grants; empty for an ordinary employee. */
  permissions: Permission[]
  /** Their access role's name, for display; null for an ordinary employee. */
  accessRoleName: string | null
  employmentType: 'HOURLY' | 'SALARIED_EXEMPT'
  departmentId: string | null
  standardMinutesPerDay: number
}

/**
 * The single source of truth for "who is asking". Reads the employee fresh on
 * every request rather than trusting the session, so a deactivated account, an
 * account the directory sync saw disabled, or a revoked permission takes
 * effect immediately instead of at token expiry.
 *
 * Returns null when there is no valid user; callers that require one should
 * use `requireUser` / `requirePermission`.
 *
 * Memoized per request with React `cache()`: a layout and its page both call a
 * guard, and the second call costs nothing. Each new request reads afresh.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await auth()
  const employeeId = session?.user?.employeeId
  if (!employeeId) return null

  const employee = await db.employee.findUnique({
    where: { id: employeeId },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      employmentType: true,
      departmentId: true,
      standardMinutesPerDay: true,
      isActive: true,
      terminationDate: true,
      identities: { select: { directoryAccountEnabled: true } },
      accessRole: { select: { name: true, permissions: true, allPermissions: true } },
    },
  })

  if (!employee) return null
  if (!resolveEmployeeForSignIn(employee, new Date()).ok) return null
  if (disabledInDirectory(employee.identities)) return null

  const {
    isActive: _isActive,
    terminationDate: _terminationDate,
    identities: _identities,
    accessRole,
    ...user
  } = employee
  return {
    ...user,
    permissions: effectivePermissions(accessRole),
    accessRoleName: accessRole?.name ?? null,
  }
})

/** Redirects to sign-in when there is no valid session. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser()
  if (!user) redirect('/signin')
  return user
}

/**
 * The gate for a page. Redirects rather than 403s so a signed-in employee who
 * follows a stale link lands somewhere useful instead of on an error page.
 */
export async function requirePermission(permission: Permission): Promise<CurrentUser> {
  const user = await requireUser()
  if (!can(user, permission)) redirect('/')
  return user
}

/** Like `requirePermission`, for a page open to any of several. */
export async function requireAnyPermission(
  permissions: readonly Permission[],
): Promise<CurrentUser> {
  const user = await requireUser()
  if (!canAny(user, permissions)) redirect('/')
  return user
}

/**
 * For Server Actions and route handlers, where a redirect is the wrong
 * response. Throws instead.
 */
export async function requirePermissionOrThrow(permission: Permission): Promise<CurrentUser> {
  const user = await getCurrentUser()
  if (!user) throw new ForbiddenError('Not signed in')
  if (!can(user, permission)) throw new ForbiddenError('You do not have access to that.')
  return user
}

/** True when the user may read this employee's time records. */
export function canViewEmployee(user: CurrentUser, employeeId: string): boolean {
  return user.id === employeeId || can(user, 'VIEW_TIME_RECORDS')
}

export async function requireSelfOrViewer(employeeId: string): Promise<CurrentUser> {
  const user = await getCurrentUser()
  if (!user) throw new ForbiddenError('Not signed in')
  if (!canViewEmployee(user, employeeId)) {
    throw new ForbiddenError('You may only access your own records')
  }
  return user
}
