/**
 * When a grant lands, and what it is worth.
 *
 * "Full allotment on January 1, or 120 days after your start date" reads like
 * two rules, and implementing it as two invites the November-hire bug: someone
 * whose waiting period ends in March gets a January 1 grant they have not
 * earned, or two grants, or none. One formula covers every case instead:
 *
 *     grantDate = max(benefitYearStart, hireDate + waitingPeriodDays)
 *
 * An existing employee's waiting period is long past, so their grant date is
 * the year start. A March 1 hire on a 120-day wait gets June 29. A November 1
 * hire's waiting period ends the following March, so the hire year produces
 * nothing at all and the next year's single grant is dated March 1 rather than
 * January 1 — which is the correct reading of "120 days after your start date".
 *
 * Pure: no database, no church-specific numbers. The 120 is a column.
 */

import { addDays, inclusiveDays, isOnOrAfter, maxDate, toDateOnly, type BenefitYear } from './dates'
import type { EmployeeInput, PolicyInput, ProposedEntry } from './types'

/**
 * The first day of `benefitYear` on which this employee is entitled to
 * anything. Shared by both accrual methods, so a lump grant and a per-period
 * accrual can never disagree about when someone becomes eligible.
 */
export function eligibilityDate(
  employee: EmployeeInput,
  policy: PolicyInput,
  benefitYear: BenefitYear,
): Date {
  return maxDate(benefitYear.start, addDays(employee.hireDate, policy.waitingPeriodDays))
}

export type Entitlement = {
  /** When eligibility begins, which for a lump policy is the grant date. */
  date: Date
  /** What the whole benefit year is worth to this employee. */
  minutes: number
  /**
   * True when eligibility starts after the year did, because the employee was
   * hired mid-year or was still inside their waiting period. This is the only
   * case in which `firstYearGrant` has anything to say.
   */
  deferred: boolean
}

/**
 * What this employee is entitled to for this benefit year, and from when.
 *
 * Returns null when they are entitled to nothing: eligibility falls past the
 * end of the year (the November hire, or anyone not yet hired), they left
 * before it arrived, or the policy grants a first year nothing at all.
 */
export function entitlementForYear(
  employee: EmployeeInput,
  policy: PolicyInput,
  benefitYear: BenefitYear,
): Entitlement | null {
  const date = eligibilityDate(employee, policy, benefitYear)

  // Eligibility lands in a later benefit year. Nothing here, and the formula
  // will produce the grant when that year is processed.
  if (isOnOrAfter(date, addDays(benefitYear.end, 1))) return null

  // Someone who leaves before their waiting period ends is granted nothing.
  if (employee.terminationDate && !isOnOrAfter(employee.terminationDate, date)) return null

  const deferred = isOnOrAfter(date, addDays(benefitYear.start, 1))
  const minutes = entitlementMinutes(policy, benefitYear, date, deferred)
  if (minutes <= 0) return null

  return { date, minutes, deferred }
}

function entitlementMinutes(
  policy: PolicyInput,
  benefitYear: BenefitYear,
  date: Date,
  deferred: boolean,
): number {
  // An employee who was eligible from the first day of the year gets the whole
  // allotment whatever `firstYearGrant` says — it only describes a first year.
  if (!deferred) return policy.annualMinutes

  switch (policy.firstYearGrant) {
    case 'FULL_AFTER_WAITING':
      return policy.annualMinutes

    case 'PRORATE': {
      const remaining = inclusiveDays(date, benefitYear.end)
      const total = inclusiveDays(benefitYear.start, benefitYear.end)
      return Math.round((policy.annualMinutes * remaining) / total)
    }

    case 'NONE':
      return 0
  }
}

/**
 * The single `LUMP_GRANT` for one employee, leave type and benefit year, or
 * null when none is due.
 *
 * `periodKey` is `<year>-LUMP`, so the unique index on
 * `(employeeId, leaveTypeId, kind, periodKey)` makes a second run a no-op
 * rather than a second allotment.
 */
export function grantLump(
  employee: EmployeeInput,
  policy: PolicyInput,
  benefitYear: BenefitYear,
): ProposedEntry | null {
  if (policy.method !== 'ANNUAL_LUMP') return null

  const entitlement = entitlementForYear(employee, policy, benefitYear)
  if (!entitlement) return null

  return {
    employeeId: employee.id,
    leaveTypeId: policy.leaveTypeId,
    effectiveDate: toDateOnly(entitlement.date),
    minutes: entitlement.minutes,
    kind: 'LUMP_GRANT',
    expiresOn: null,
    periodKey: `${benefitYear.label}-LUMP`,
    sourceType: 'LeavePolicy',
    sourceId: policy.id,
  }
}
