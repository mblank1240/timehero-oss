/**
 * Benefit-year rollover.
 *
 * **Zero out, then re-grant.** A balance is a cumulative `SUM` over every
 * entry ever written, so it carries into the new year on its own. Rollover's
 * job is to *remove* what is not kept, not to move anything. Writing a
 * `ROLLOVER_IN` for the carried amount without first forfeiting the whole
 * closing balance doubles everyone's time — an earlier draft of the spec had
 * exactly that bug, which is why it is a required test.
 *
 * The forfeit also reads better in an employee's history: "200 forfeited, 40
 * carried" rather than a bare −160 nobody can interpret.
 *
 * Pure. The caller writes the returned entries in one transaction.
 */

import { balanceOf } from './balance'
import {
  addDays,
  isWithinMonthDayWindow,
  resolveMonthDay,
  toUtcDay,
  type BenefitYear,
} from './dates'
import { grantLump } from './grant'
import { lotBalances } from './lots'
import type {
  CapBasis,
  CarryoverWindowInput,
  EmployeeInput,
  ExistingEntry,
  LeaveTypeInput,
  Lot,
  PolicyInput,
  ProposedEntry,
  RolloverRuleInput,
} from './types'

export type RolloverArgs = {
  employee: EmployeeInput
  leaveType: LeaveTypeInput
  /** The org rule for this leave type. Null is treated as "nothing carries". */
  rule: RolloverRuleInput | null
  /** Active windows for this leave type. */
  windows: readonly CarryoverWindowInput[]
  /** The policy in force for the new year, for the lump grant. */
  policy: PolicyInput | null
  /** Every ledger entry for this employee and leave type. */
  entries: readonly ExistingEntry[]
  /** The benefit year that is ending. */
  closingYear: BenefitYear
  /** The benefit year that is beginning. Its first day dates every entry. */
  newYear: BenefitYear
}

/** What the rollover decided, for the job log and for tests to assert on. */
export type RolloverResult = {
  entries: ProposedEntry[]
  /** The closing balance that was forfeited. */
  closingBalanceMinutes: number
  /** Kept under the org rule. */
  baseCarryMinutes: number
  /** Kept by a carryover window that the org rule would have forfeited. */
  windowCarryMinutes: number
  forfeitedMinutes: number
}

/**
 * The entries that close one benefit year and open the next, for one employee
 * and one leave type.
 */
export function runRollover(args: RolloverArgs): RolloverResult {
  const { employee, leaveType, rule, entries, closingYear, newYear } = args
  const day1 = newYear.start

  const closing = balanceOf(entries, closingYear.end)
  const { lots } = lotBalances(entries, closingYear.end)

  /**
   * A lot whose `expiresOn` is the old year's last day dies on the very date
   * this rollover is written, so the rollover and the expiry job are both
   * looking at the same minutes on the same morning. Two corrections are
   * needed, and without both the result depends on which job GitHub happened
   * to run first:
   *
   * - whatever an expiry has *already* forfeited on day 1 must not be
   *   forfeited again, or the balance goes negative;
   * - expired time cannot be carried, or running the rollover first would
   *   resurrect it as a fresh `ROLLOVER_IN` with no expiry at all.
   *
   * With both, either order lands on the same answer: the time is gone.
   */
  const alreadyExpired = expiryForfeitedOn(entries, day1)
  const expiredRemainder = lots
    .filter((lot) => lot.expiresOn !== null && toUtcDay(lot.expiresOn) < toUtcDay(day1))
    .reduce((sum, lot) => sum + lot.remainingMinutes, 0)

  const toForfeit = closing - alreadyExpired

  const result: RolloverResult = {
    entries: [],
    closingBalanceMinutes: closing,
    baseCarryMinutes: 0,
    windowCarryMinutes: 0,
    forfeitedMinutes: 0,
  }

  if (toForfeit > 0) {
    const carryable = Math.max(0, toForfeit - expiredRemainder)

    // A type with `countsTowardRollover = false` keeps nothing under the org
    // rule, whatever cap the rule names. A carryover window can still rescue
    // part of it — that is the whole point of a window, and it is how comp
    // time ends up carrying only what was earned in December.
    const base = leaveType.countsTowardRollover
      ? applyCap(carryable, rule?.capBasis ?? 'NONE', rule?.capValue ?? 0, employee)
      : 0

    // `applyCap` already bounds the base carry by what is carryable, so the
    // headroom a window may use is simply what the base did not keep.
    const matched = matchWindows(args, carryable - base, lots)
    const windowCarry = matched.reduce((sum, w) => sum + w.minutes, 0)

    // Step 5 before step 6, always. This zeroes the type.
    result.entries.push({
      employeeId: employee.id,
      leaveTypeId: leaveType.id,
      effectiveDate: day1,
      minutes: -toForfeit,
      kind: 'FORFEIT',
      expiresOn: null,
      periodKey: `${newYear.label}-ROLLOVER`,
      note: `Benefit year ${closingYear.label} closing balance`,
    })

    if (base > 0) {
      result.entries.push({
        employeeId: employee.id,
        leaveTypeId: leaveType.id,
        effectiveDate: day1,
        minutes: base,
        kind: 'ROLLOVER_IN',
        expiresOn: carriedExpiry(rule, newYear),
        // Paired with the FORFEIT above under one key, so the two are written
        // and re-run as a unit.
        periodKey: `${newYear.label}-ROLLOVER`,
        note: `Carried from ${closingYear.label}`,
      })
    }

    for (const window of matched) {
      result.entries.push({
        employeeId: employee.id,
        leaveTypeId: leaveType.id,
        effectiveDate: day1,
        minutes: window.minutes,
        kind: 'ROLLOVER_IN',
        expiresOn: window.expiresOn,
        // One key per source: the unique index is on
        // (employee, type, kind, periodKey), so two ROLLOVER_IN rows under one
        // key would collide and the second carry would be silently dropped.
        // Keyed by window id rather than name, so renaming a window does not
        // let the next run write a duplicate carry.
        periodKey: `${newYear.label}-ROLLOVER-${window.id}`,
        note: window.name,
      })
    }

    result.baseCarryMinutes = base
    result.windowCarryMinutes = windowCarry
    result.forfeitedMinutes = toForfeit - base - windowCarry
  }

  // Step 7, and the reason it sits outside the `closing > 0` branch: a new
  // hire with no balance to carry is still owed this year's allotment.
  if (args.policy) {
    const lump = grantLump(employee, args.policy, newYear)
    if (lump) result.entries.push(lump)
  }

  return result
}

/**
 * `EMPLOYEE_DAYS` multiplies by that employee's own working day, so "5 days"
 * is 2400 minutes for full-time staff and 1200 for someone on a 4-hour day.
 * A fixed minute cap would hand the part-timer ten days of rollover while
 * full-time staff got five (docs/DECISIONS.md).
 */
export function applyCap(
  amount: number,
  basis: CapBasis,
  value: number,
  employee: Pick<EmployeeInput, 'standardMinutesPerDay'>,
): number {
  switch (basis) {
    case 'NONE':
      return 0
    case 'UNLIMITED':
      return amount
    case 'FIXED_MINUTES':
      return Math.min(amount, Math.max(0, value))
    case 'EMPLOYEE_DAYS':
      return Math.min(amount, Math.max(0, value * employee.standardMinutesPerDay))
  }
}

type MatchedWindow = {
  id: string
  name: string
  minutes: number
  expiresOn: Date
}

/**
 * What the carryover windows rescue, beyond what the org rule already kept.
 *
 * A window looks at lots, not at the balance: it rescues the *unconsumed
 * remainder* of grants earned inside its month/day range during the closing
 * year. Comp banked in December and already spent in December is not carried
 * twice.
 *
 * `headroom` is the closing balance less the base carry. Trimming the window
 * share rather than the base share keeps the employee's non-expiring time in
 * preference to time that is about to run out.
 */
function matchWindows(
  args: RolloverArgs,
  headroom: number,
  lots: readonly Lot[],
): MatchedWindow[] {
  if (args.windows.length === 0 || headroom <= 0) return []

  const yearStart = toUtcDay(args.closingYear.start)
  const yearEnd = toUtcDay(args.closingYear.end)
  const dayOne = toUtcDay(args.newYear.start)

  const matched: MatchedWindow[] = []
  let left = headroom

  for (const window of args.windows) {
    if (left <= 0) break

    const expiresOn = windowExpiry(window, args.closingYear)
    // A window that expires before the new year even begins rescues nothing:
    // the time would be unusable on the very day it was carried. A
    // `usableUntilYearOffset` of 0 does exactly this, and the ledger's
    // expiry-after-effective CHECK would reject the row and take the rest of
    // the rollover down with it.
    if (toUtcDay(expiresOn) < dayOne) continue

    let earned = 0
    for (const lot of lots) {
      if (lot.remainingMinutes <= 0) continue
      // Time that has already expired is not the window's to rescue.
      if (lot.expiresOn !== null && toUtcDay(lot.expiresOn) < dayOne) continue
      const day = toUtcDay(lot.effectiveDate)
      // Only time earned during the year that is closing. A lot left over from
      // an earlier year has already had its chance at this window.
      if (day < yearStart || day > yearEnd) continue
      if (
        !isWithinMonthDayWindow(
          lot.effectiveDate,
          window.earnedFromMonth,
          window.earnedFromDay,
          window.earnedToMonth,
          window.earnedToDay,
        )
      ) {
        continue
      }
      earned += lot.remainingMinutes
    }

    const capped = Math.min(applyCap(earned, window.capBasis, window.capValue, args.employee), left)
    if (capped <= 0) continue

    matched.push({ id: window.id, name: window.name, minutes: capped, expiresOn })
    left -= capped
  }

  return matched
}

/**
 * When time rescued by a window stops being spendable.
 *
 * The offset counts from the calendar year the window's earning period ends
 * in, which for a calendar benefit year is the year that just closed: comp
 * earned in December 2026 is usable until February 2027. Resolving the year
 * this way rather than from the benefit year's label keeps a non-calendar
 * benefit year (a July start) pointing at the right February.
 */
function windowExpiry(window: CarryoverWindowInput, closingYear: BenefitYear): Date {
  const candidates = [closingYear.start.getUTCFullYear(), closingYear.end.getUTCFullYear()]

  const earnedEndYear =
    candidates.find((year) => {
      const end = toUtcDay(resolveMonthDay(year, window.earnedToMonth, window.earnedToDay))
      return end >= toUtcDay(closingYear.start) && end <= toUtcDay(closingYear.end)
    }) ?? closingYear.end.getUTCFullYear()

  return resolveMonthDay(
    earnedEndYear + window.usableUntilYearOffset,
    window.usableUntilMonth,
    window.usableUntilDay,
  )
}

/**
 * Minutes a lot expiry has already removed on `day`, as a positive number.
 * Recognised by the `-EXPIRY` idempotency key, which only `expireLots` writes.
 */
function expiryForfeitedOn(entries: readonly ExistingEntry[], day: Date): number {
  const target = toUtcDay(day)

  let total = 0
  for (const entry of entries) {
    if (entry.kind !== 'FORFEIT') continue
    if (!entry.periodKey?.endsWith('-EXPIRY')) continue
    if (toUtcDay(entry.effectiveDate) !== target) continue
    total += -entry.minutes
  }

  return total
}

/** Null when carried time never expires, which is the common case. */
function carriedExpiry(rule: RolloverRuleInput | null, newYear: BenefitYear): Date | null {
  if (!rule || rule.carriedExpiresAfterDays === null) return null
  return addDays(newYear.start, rule.carriedExpiresAfterDays)
}
