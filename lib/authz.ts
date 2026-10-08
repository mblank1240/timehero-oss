import { redirect } from 'next/navigation'
import { cache } from 'react'

import type { Role } from '@/lib/employees/schema'
import { canReadReports } from '@/lib/roles'

import { auth } from './auth'
import { db } from './db'
import { disabledInDirectory } from './directory/link'
import { resolveEmployeeForSignIn } from './sign-in'

export { canReadReports }

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
  role: Role
  employmentType: 'HOURLY' | 'SALARIED_EXEMPT'
  departmentId: string | null
  standardMinutesPerDay: number
}

/**
 * The single source of truth for "who is asking". Reads the employee fresh on
 * every request rather than trusting the session, so a deactivated account, an
 * account the directory sync saw disabled, or a revoked admin role takes
 * effect immediately instead of at token expiry.
 *
 * Returns null when there is no valid user; callers that require one should
 * use `requireUser` / `requireAdmin`.
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
      role: true,
      employmentType: true,
      departmentId: true,
      standardMinutesPerDay: true,
      isActive: true,
      terminationDate: true,
      identities: { select: { directoryAccountEnabled: true } },
    },
  })

  if (!employee) return null
  if (!resolveEmployeeForSignIn(employee, new Date()).ok) return null
  if (disabledInDirectory(employee.identities)) return null

  const {
    isActive: _isActive,
    terminationDate: _terminationDate,
    identities: _identities,
    ...user
  } = employee
  return user
})

/** Redirects to sign-in when there is no valid session. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser()
  if (!user) redirect('/signin')
  return user
}

/**
 * Admin gate. Redirects rather than 403s so a signed-in non-admin who follows
 * a stale link lands somewhere useful instead of on an error page.
 */
export async function requireAdmin(): Promise<CurrentUser> {
  const user = await requireUser()
  if (user.role !== 'ADMIN') redirect('/')
  return user
}

/**
 * For Server Actions and route handlers, where a redirect is the wrong
 * response. Throws instead.
 */
export async function requireAdminOrThrow(): Promise<CurrentUser> {
  const user = await getCurrentUser()
  if (!user) throw new ForbiddenError('Not signed in')
  if (user.role !== 'ADMIN') throw new ForbiddenError('Administrator access required')
  return user
}

/** The reports gate for pages. Redirects like `requireAdmin`. */
export async function requireReportsAccess(): Promise<CurrentUser> {
  const user = await requireUser()
  if (!canReadReports(user)) redirect('/')
  return user
}

/** The reports gate for route handlers, which must answer rather than redirect. */
export async function requireReportsAccessOrThrow(): Promise<CurrentUser> {
  const user = await getCurrentUser()
  if (!user) throw new ForbiddenError('Not signed in')
  if (!canReadReports(user)) throw new ForbiddenError('Report access required')
  return user
}

/** True when the user may read or write this employee's records. */
export function canAccessEmployee(user: CurrentUser, employeeId: string): boolean {
  return user.role === 'ADMIN' || user.id === employeeId
}

export async function requireSelfOrAdmin(employeeId: string): Promise<CurrentUser> {
  const user = await getCurrentUser()
  if (!user) throw new ForbiddenError('Not signed in')
  if (!canAccessEmployee(user, employeeId)) {
    throw new ForbiddenError('You may only access your own records')
  }
  return user
}
