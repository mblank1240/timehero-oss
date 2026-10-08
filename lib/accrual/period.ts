/**
 * Per-pay-period accrual, computed from a cumulative target.
 *
 * `annualMinutes / periodsPerYear` rarely divides evenly: 7200 minutes over 26
 * periods is 276.92. Granting a rounded 277 every period overshoots the annual
 * allotment by 2 minutes; truncating to 276 shorts the employee by 24. Neither
 * error is visible until year end, and both are real time.
 *
 * So each grant is the difference between where the year should stand and what
 * has already been granted:
 *
 *     targetToDate = round(entitlement * periodsElapsed / periodsInPlan)
 *     grant        = targetToDate - (PERIOD_ACCRUAL minutes already this year)
 *
 * Grants alternate 277 and 276, the running total is never off by more than a
 * minute, and the year-end total is exactly the allotment. The formula also
 * self-corrects: a skipped or late period is caught up by the next run rather
 * than lost, because the target does not care how it was reached.
 *
 * Pure. Persisting the result is `lib/ledger/`'s job.
 */

import { generatePeriods, periodsPerYear, type PayScheduleInput } from '@/lib/payperiods/generate'

import { balanceOf, sumOfKind } from './balance'
import { isOnOrAfter, isSameDay, toUtcDay, type BenefitYear } from './dates'
import { entitlementForYear } from './grant'
import type { EmployeeInput, ExistingEntry, PolicyInput, ProposedEntry } from './types'

export type PeriodRef = {
  startDate: Date
  /** Inclusive. A period belongs to the benefit year containing this date. */
  endDate: Date
}

export type AccruePayPeriodArgs = {
  employee: EmployeeInput
  policy: PolicyInput
  /** The benefit year containing the period's end date. */
  benefitYear: BenefitYear
  schedule: PayScheduleInput
  period: PeriodRef
  /** Every ledger entry for this employee and leave type. */
  entries: readonly ExistingEntry[]
}

/**
 * Every pay period belonging to `benefitYear` — the ones whose *end* date
 * falls inside it, in order.
 *
 * End date rather than start, so a period straddling the boundary belongs to
 * exactly one year and accrues on the day it closes. Counting it in both, or
 * in neither, is how a year ends up a period short.
 */
export function benefitYearPeriods(
  schedule: PayScheduleInput,
  benefitYear: BenefitYear,
): PeriodRef[] {
  const from = toUtcDay(benefitYear.start)
  const through = toUtcDay(benefitYear.end)

  return generatePeriods(schedule, { from: benefitYear.start, through: benefitYear.end })
    .filter((p) => {
      const end = toUtcDay(p.endDate)
      return end >= from && end <= through
    })
    .map((p) => ({ startDate: p.startDate, endDate: p.endDate }))
}

/**
 * The accrual due for one pay period, or null when none is.
 *
 * Returns null — rather than a zero-minute entry — whenever the target has
 * already been reached, the employee is not yet eligible, they have left, or
 * the balance is sitting at the policy ceiling. A ledger of zero-minute rows
 * would be noise in the one history an employee actually reads.
 */
export function accruePayPeriod(args: AccruePayPeriodArgs): ProposedEntry | null {
  const { employee, policy, benefitYear, schedule, period, entries } = args
  if (policy.method !== 'PER_PAY_PERIOD') return null

  // Nothing accrues for a period that closes after someone has left. The
  // period they leave mid-way through is not accrued either: the allotment is
  // earned by completing the period, and a part-period grant would need a
  // proration rule the policy does not have.
  if (employee.terminationDate && !isOnOrAfter(employee.terminationDate, period.endDate)) {
    return null
  }

  const entitlement = entitlementForYear(employee, policy, benefitYear)
  if (!entitlement) return null

  const yearPeriods = benefitYearPeriods(schedule, benefitYear)

  // The period's place in the benefit year, counted from the year start and
  // independent of this employee. It names the entry's idempotency key, so a
  // later edit to the waiting period cannot renumber keys already written and
  // let a re-run grant the same period twice under a new name.
  const periodNumber = yearPeriods.findIndex((p) => isSameDay(p.endDate, period.endDate)) + 1
  if (periodNumber === 0) return null

  // Only the periods the employee is actually eligible for. A new hire whose
  // waiting period ends in period 10 must not be handed 10/26 of the year in
  // one grant, which is what counting from the year start would do.
  const plan = yearPeriods.filter((p) => isOnOrAfter(p.endDate, entitlement.date))

  const elapsed = plan.findIndex((p) => isSameDay(p.endDate, period.endDate)) + 1
  // The period closes before eligibility begins.
  if (elapsed === 0) return null

  /**
   * A full-year employee is divided by the nominal count the policy is written
   * against, not by however many periods this calendar year happens to hold —
   * a biweekly year occasionally has 27, and paying 27/26 of the allotment
   * then is deliberate (see `periodsPerYear`).
   *
   * A deferred employee is divided by the periods they are actually eligible
   * for, so `FULL_AFTER_WAITING` means the whole allotment spread across the
   * rest of the year and still sums to exactly `annualMinutes`.
   */
  const divisor = entitlement.deferred ? plan.length : periodsPerYear(schedule.type)
  if (divisor <= 0) return null

  const targetToDate = Math.round((entitlement.minutes * elapsed) / divisor)
  const alreadyGranted = sumOfKind(entries, 'PERIOD_ACCRUAL', {
    from: benefitYear.start,
    through: benefitYear.end,
  })

  // Never negative: an admin adjustment or a shrunk allotment can put the year
  // ahead of its target, and the engine's answer to that is to grant nothing
  // until the target catches up, not to claw time back.
  let minutes = Math.max(0, targetToDate - alreadyGranted)
  minutes = applyCeiling(minutes, policy, entries, period.endDate)
  if (minutes <= 0) return null

  return {
    employeeId: employee.id,
    leaveTypeId: policy.leaveTypeId,
    effectiveDate: period.endDate,
    minutes,
    kind: 'PERIOD_ACCRUAL',
    expiresOn: null,
    periodKey: periodKeyFor(benefitYear, periodNumber),
    sourceType: 'LeavePolicy',
    sourceId: policy.id,
  }
}

/**
 * `maxBalanceMinutes` is an any-time ceiling, so it caps the grant rather than
 * cancelling it: a balance 60 minutes below the ceiling still accrues those 60.
 * Accrual pauses entirely at the ceiling and resumes once the balance drops —
 * and because the target is cumulative, the paused periods are then caught up,
 * bounded by the headroom that opened.
 */
function applyCeiling(
  minutes: number,
  policy: PolicyInput,
  entries: readonly ExistingEntry[],
  asOf: Date,
): number {
  if (policy.maxBalanceMinutes === null) return minutes

  const headroom = policy.maxBalanceMinutes - balanceOf(entries, asOf)
  return Math.max(0, Math.min(minutes, headroom))
}

/** `2026-PP07` — the idempotency key from docs/DATA-MODEL.md. */
export function periodKeyFor(benefitYear: BenefitYear, periodNumber: number): string {
  return `${benefitYear.label}-PP${String(periodNumber).padStart(2, '0')}`
}

/**
 * What it takes to finish a benefit year's per-pay-period accrual, read by
 * the rollover just before it closes the year.
 *
 * - `complete` — nothing is owed. The usual answer: the last period was
 *   accrued on the day it closed.
 * - `settled` — the accrual for the year's last period, which was never
 *   written. Within a year a missed run costs nothing, because the next
 *   period's cumulative target catches it up; the *last* period has no next
 *   period in the same year, so a missed run on its end date would otherwise
 *   be lost — and the rollover, reading the closing balance without it, would
 *   then be stale for good.
 * - `untracked` — the formula says something is owed, but the ledger has no
 *   entry at all for this employee and type dated in the year. That is what
 *   a system that was not yet live looks like (an install, or an import cut
 *   over, after the year ended), and granting a whole year's allotment into
 *   a closed year on that evidence would be a windfall. So it is reported,
 *   not written: an administrator decides.
 */
export type YearSettlement =
  | { status: 'complete' }
  | { status: 'settled'; entry: ProposedEntry }
  | { status: 'untracked'; minutes: number }

export function settleBenefitYear(args: Omit<AccruePayPeriodArgs, 'period'>): YearSettlement {
  const final = benefitYearPeriods(args.schedule, args.benefitYear).at(-1)
  if (!final) return { status: 'complete' }

  // The cumulative target at the last period is the whole year's allotment,
  // so this one figure settles every period the year is short, not just the
  // last. Already written, it comes back null.
  const entry = accruePayPeriod({ ...args, period: final })
  if (!entry) return { status: 'complete' }

  const yearEnd = toUtcDay(args.benefitYear.end)
  const yearStart = toUtcDay(args.benefitYear.start)
  const tracked = args.entries.some((e) => {
    const day = toUtcDay(e.effectiveDate)
    return day >= yearStart && day <= yearEnd
  })

  return tracked ? { status: 'settled', entry } : { status: 'untracked', minutes: entry.minutes }
}
