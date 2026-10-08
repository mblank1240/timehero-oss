/**
 * Projecting a ledger forward: what will this balance be on a future date?
 *
 * A leave request for next March has to be checked against next March's
 * balance, and that balance does not exist yet. It is today's ledger plus
 * everything the jobs will write between now and then — the pay periods that
 * close, the lump grant on the benefit-year start, the rollover that forfeits
 * and re-grants, the carried comp that expires. Rather than approximating any
 * of that, this runs the engine's own pure functions forward one day at a
 * time, in the order the daily jobs would, over a copy of the ledger.
 *
 * Because it *is* the engine, a projection can only disagree with what the
 * jobs later write if the configuration changes in between — a new policy, a
 * different allotment. That is why a request is checked twice: at submission
 * and again at final approval.
 *
 * Hypothetical usage (the request being validated, other requests still
 * pending) goes in as ordinary entries. It matters that it does: a rollover
 * caps what is left *after* the spending, and an expiring lot is consumed
 * before a permanent one, so the projection of a balance depends on when the
 * time is spent and not just on how much.
 *
 * Pure. No database, no church-specific numbers.
 */

import { periodContaining, type PayScheduleInput } from '@/lib/payperiods/generate'

import { balanceOf } from './balance'
import { addDays, benefitYearContaining, fromUtcDay, isSameDay, toUtcDay } from './dates'
import { expireLots } from './expiry'
import { grantLump } from './grant'
import { accruePayPeriod } from './period'
import { runRollover } from './rollover'
import type {
  CarryoverWindowInput,
  EmployeeInput,
  ExistingEntry,
  LeaveTypeInput,
  PolicyInput,
  ProposedEntry,
  RolloverRuleInput,
} from './types'

export type ProjectionArgs = {
  employee: EmployeeInput
  leaveType: LeaveTypeInput
  /**
   * The policy in force today, assumed to stay in force. Null projects no
   * accrual at all, which is the honest answer for someone with no policy.
   */
  policy: PolicyInput | null
  rule: RolloverRuleInput | null
  windows: readonly CarryoverWindowInput[]
  /** Needed only by a per-pay-period policy. */
  schedule: PayScheduleInput | null
  benefitYearStart: { month: number; day: number }
  /** The real ledger for this employee and type, plus any hypothetical usage. */
  entries: readonly ExistingEntry[]
  /**
   * The first day whose jobs may not have run yet — today. Anything already
   * written for it is recognised by its idempotency key and not projected
   * twice.
   */
  from: Date
  /** The last day to project, inclusive. */
  through: Date
}

/**
 * The entries the jobs would write from `from` through `through`, in the order
 * they would write them. Returns only the projected entries; combine them with
 * `args.entries` for a balance.
 */
export function projectEntries(args: ProjectionArgs): ExistingEntry[] {
  const { employee, leaveType, policy, rule, windows, schedule, from, through } = args
  const { month, day: startDay } = args.benefitYearStart

  const ledger: ExistingEntry[] = [...args.entries]
  const projected: ExistingEntry[] = []

  // The unique index the real write leans on, `(kind, periodKey)` within one
  // employee and type. Emulating it is what lets a projection start on a day
  // whose jobs have already run without granting that day twice.
  const written = new Set(
    ledger.filter((e) => e.periodKey).map((e) => `${e.kind}|${String(e.periodKey)}`),
  )

  const add = (entry: ProposedEntry) => {
    if (entry.periodKey) {
      const key = `${entry.kind}|${entry.periodKey}`
      if (written.has(key)) return
      written.add(key)
    }

    const row: ExistingEntry = {
      // Sorts after every real cuid on the same day, and stays deterministic.
      id: `~projected-${String(projected.length).padStart(5, '0')}`,
      effectiveDate: entry.effectiveDate,
      minutes: entry.minutes,
      kind: entry.kind,
      expiresOn: entry.expiresOn,
      periodKey: entry.periodKey,
    }
    ledger.push(row)
    projected.push(row)
  }

  const hasExpiringTime = () => ledger.some((e) => e.expiresOn !== null)
  const last = toUtcDay(through, 'through')

  for (let day = from; toUtcDay(day) <= last; day = addDays(day, 1)) {
    const year = benefitYearContaining(day, month, startDay)

    // The rollover job: the forfeit, the carry, and the new year's lump grant.
    if (isSameDay(day, year.start)) {
      const closingYear = benefitYearContaining(addDays(day, -1), month, startDay)
      const result = runRollover({
        employee,
        leaveType,
        rule,
        windows,
        policy,
        entries: ledger,
        closingYear,
        newYear: year,
      })
      result.entries.forEach(add)
    }

    if (policy?.method === 'ANNUAL_LUMP') {
      // The daily accrual job writes a lump grant once it is due, catching up
      // if a run was missed — so anything due on or before today counts.
      const grant = grantLump(employee, policy, year)
      if (grant && toUtcDay(grant.effectiveDate) <= toUtcDay(day)) add(grant)
    }

    if (policy?.method === 'PER_PAY_PERIOD' && schedule) {
      const period = periodContaining(schedule, day)
      if (period && isSameDay(period.endDate, day)) {
        const accrual = accruePayPeriod({
          employee,
          policy,
          benefitYear: benefitYearContaining(period.endDate, month, startDay),
          schedule,
          period: { startDate: period.startDate, endDate: period.endDate },
          entries: ledger,
        })
        if (accrual) add(accrual)
      }
    }

    // The expiry job. Skipped outright when nothing in the account expires,
    // which is every leave type except carried comp.
    if (hasExpiringTime()) {
      expireLots({ employee, leaveTypeId: leaveType.id, entries: ledger, asOf: day }).forEach(add)
    }
  }

  return projected
}

export type Shortfall = {
  /** The first date the balance is below zero. */
  date: Date
  /** The balance on that date — negative. */
  balanceMinutes: number
}

/**
 * The first point, on or after `from`, at which spending leaves the balance
 * below zero, or null when there is none.
 *
 * Checked at every date some usage lands on, not only the dates of the request
 * being validated. A request for October can be affordable in October and
 * still leave an already-approved December request uncovered; the employee
 * has to hear about that now, not in December.
 */
export function firstShortfall(entries: readonly ExistingEntry[], from: Date): Shortfall | null {
  const start = toUtcDay(from, 'from')

  const usageDays = [
    ...new Set(
      entries
        .filter((e) => e.kind === 'USAGE' && toUtcDay(e.effectiveDate) >= start)
        .map((e) => toUtcDay(e.effectiveDate)),
    ),
  ].sort((a, b) => a - b)

  for (const day of usageDays) {
    const date = fromUtcDay(day)
    const balance = balanceOf(entries, date)
    if (balance < 0) return { date, balanceMinutes: balance }
  }

  return null
}
