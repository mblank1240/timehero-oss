/**
 * What a directory sync should do, as a pure function.
 *
 * The directory is the organization's record of who has an account, not of
 * who is employed on what terms — so a sync adds and links people, and flags
 * changes for an administrator, but never decides anything about pay or
 * leave:
 *
 * - **Link** an enabled member account to the employee with its address,
 *   when that employee has no account of this kind bound yet.
 * - **Create** an employee for an enabled member account with no match, when
 *   the connection allows it. New employees are marked for review and given
 *   no pay schedule or leave policy, so nothing accrues and no timesheet is
 *   created until an administrator has set them up.
 * - **Flag** an employee whose bound account has been disabled. They are not
 *   deactivated: leaving is an HR decision with a termination date, and an
 *   account can be disabled for other reasons.
 *
 * Guests, disabled accounts nobody is bound to, and addresses outside the
 * organization's domains are skipped and counted.
 */

import { addDays } from '@/lib/accrual/dates'

import { emailDomain } from './link'

export type DirectoryUser = {
  id: string
  displayName: string | null
  givenName: string | null
  surname: string | null
  mail: string | null
  userPrincipalName: string
  accountEnabled: boolean
  userType: string | null
  employeeHireDate: string | null
}

export type KnownEmployee = {
  id: string
  email: string
  isActive: boolean
  /** Subjects already bound for this provider. */
  subjects: string[]
}

export type SyncPlan = {
  link: { employeeId: string; user: DirectoryUser }[]
  create: DirectoryUser[]
  /** Bound accounts, with the state the directory reports now. */
  refresh: { subject: string; enabled: boolean; email: string }[]
  /** Employees to mark for review because their account is disabled. */
  flagDisabled: string[]
  skipped: {
    guests: number
    disabledUnbound: number
    outsideDomains: number
    duplicateAddress: number
  }
}

/** The address a directory user goes by: their mailbox, else their sign-in name. */
export function addressOf(user: DirectoryUser): string {
  return (user.mail ?? user.userPrincipalName).trim().toLowerCase()
}

export function planDirectorySync(args: {
  users: readonly DirectoryUser[]
  employees: readonly KnownEmployee[]
  domains: readonly string[]
  autoProvision: boolean
}): SyncPlan {
  const domains = new Set(args.domains.map((d) => d.toLowerCase()))
  const bySubject = new Map<string, KnownEmployee>()
  const byEmail = new Map<string, KnownEmployee>()
  for (const e of args.employees) {
    byEmail.set(e.email.toLowerCase(), e)
    for (const s of e.subjects) bySubject.set(s, e)
  }

  // Two directory accounts with one address cannot both be that employee.
  const addressCount = new Map<string, number>()
  for (const u of args.users)
    addressCount.set(addressOf(u), (addressCount.get(addressOf(u)) ?? 0) + 1)

  const plan: SyncPlan = {
    link: [],
    create: [],
    refresh: [],
    flagDisabled: [],
    skipped: {
      guests: 0,
      disabledUnbound: 0,
      outsideDomains: 0,
      duplicateAddress: 0,
    },
  }

  for (const user of args.users) {
    const bound = bySubject.get(user.id)
    if (bound) {
      plan.refresh.push({
        subject: user.id,
        enabled: user.accountEnabled,
        email: addressOf(user),
      })
      if (!user.accountEnabled && bound.isActive) plan.flagDisabled.push(bound.id)
      continue
    }

    if (user.userType && user.userType !== 'Member') {
      plan.skipped.guests += 1
      continue
    }
    if (!user.accountEnabled) {
      plan.skipped.disabledUnbound += 1
      continue
    }
    const address = addressOf(user)
    if (!domains.has(emailDomain(address))) {
      plan.skipped.outsideDomains += 1
      continue
    }
    if ((addressCount.get(address) ?? 0) > 1) {
      plan.skipped.duplicateAddress += 1
      continue
    }

    const match = byEmail.get(address)
    if (match) {
      // Already bound to a different account of this kind: leave it to a person.
      if (match.subjects.length === 0) plan.link.push({ employeeId: match.id, user })
      else plan.skipped.duplicateAddress += 1
      continue
    }
    if (args.autoProvision) plan.create.push(user)
  }

  return plan
}

/**
 * A new employee from a directory account. Everything the directory cannot
 * know is left at its safest value for an administrator to confirm:
 *
 * - `HOURLY`, because the opposite mistake — an hourly person marked exempt —
 *   would let them bank comp time, which FLSA forbids (rule 4).
 * - No pay schedule and no leave policy, so nothing accrues and no timesheet
 *   is created yet.
 * - The directory's hire date when HR has set one, else the sync date.
 */
export function employeeFromDirectoryUser(user: DirectoryUser, asOf: Date) {
  const [first, ...rest] = (user.displayName ?? '').trim().split(/\s+/)
  const hire = user.employeeHireDate ? new Date(user.employeeHireDate) : null
  const hireDate =
    hire && !Number.isNaN(hire.getTime())
      ? new Date(Date.UTC(hire.getUTCFullYear(), hire.getUTCMonth(), hire.getUTCDate()))
      : addDays(asOf, 0)

  return {
    email: addressOf(user),
    firstName: user.givenName?.trim() || first || addressOf(user).split('@')[0],
    lastName: user.surname?.trim() || rest.join(' ') || '',
    role: 'EMPLOYEE' as const,
    employmentType: 'HOURLY' as const,
    hireDate,
    needsReview: true,
  }
}
