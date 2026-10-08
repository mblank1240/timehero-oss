/**
 * What the dashboard says about one leave type, read off a projected ledger.
 *
 * The projection is `projectEntries()` — the engine run forward over the real
 * ledger — so the dashboard and the request form cannot disagree about what
 * is coming: both are asking the same engine. These functions only pick the
 * interesting rows out of what it returns.
 *
 * Pure. No database, no church-specific numbers.
 */

import { addDays, toUtcDay } from '@/lib/accrual/dates'
import type { ExistingEntry } from '@/lib/accrual/types'

export type NextAccrual = { date: Date; minutes: number }

/**
 * The first grant the jobs will write after `today` — a lump grant or a
 * pay-period accrual — or null when none is projected. Anything due today is
 * already in today's balance, so it is not "next". A rollover's carried time
 * is not an accrual either: it is the employee's own time moving across the
 * boundary, not new time.
 */
export function nextAccrual(projected: readonly ExistingEntry[], today: Date): NextAccrual | null {
  const after = toUtcDay(today)
  const grant = sortedByDay(projected).find(
    (e) =>
      (e.kind === 'LUMP_GRANT' || e.kind === 'PERIOD_ACCRUAL') &&
      e.minutes > 0 &&
      toUtcDay(e.effectiveDate) > after,
  )
  return grant ? { date: grant.effectiveDate, minutes: grant.minutes } : null
}

export type ProjectedLoss = {
  /** The day the time is forfeited. */
  date: Date
  /** The last day it can still be used — the day before it goes. */
  usableThrough: Date
  /** How much is lost, as a positive count of minutes. */
  minutes: number
}

/**
 * The first date after `today` on which the projection forfeits time the
 * employee does not get back, or null when nothing is lost. A forfeit dated
 * today is already past its last usable day and already in today's balance.
 *
 * Two jobs forfeit: the rollover, which forfeits the whole closing balance and
 * re-grants what the cap carries, and lot expiry. Netting `FORFEIT` against
 * `ROLLOVER_IN` on the same date covers both without telling them apart — a
 * rollover under its cap nets to zero, and an expiry has no re-grant to net
 * against. Both are dated the day *after* the last usable one, which is what
 * `usableThrough` reports.
 */
export function nextLoss(projected: readonly ExistingEntry[], today: Date): ProjectedLoss | null {
  const after = toUtcDay(today)
  const netByDay = new Map<number, number>()
  const forfeits = new Map<number, Date>()

  for (const entry of projected) {
    if (entry.kind !== 'FORFEIT' && entry.kind !== 'ROLLOVER_IN') continue
    const day = toUtcDay(entry.effectiveDate)
    if (day <= after) continue
    netByDay.set(day, (netByDay.get(day) ?? 0) + entry.minutes)
    if (entry.kind === 'FORFEIT') forfeits.set(day, entry.effectiveDate)
  }

  for (const [day, date] of [...forfeits].sort(([a], [b]) => a - b)) {
    const net = netByDay.get(day) ?? 0
    if (net < 0) return { date, usableThrough: addDays(date, -1), minutes: -net }
  }

  return null
}

/**
 * Approved leave already written to the ledger but dated after `today`: time
 * that is still in today's balance and already spoken for. A cancellation's
 * reversal nets against it.
 */
export function bookedAfter(ledger: readonly ExistingEntry[], today: Date): number {
  const after = toUtcDay(today)
  return ledger
    .filter(
      (e) =>
        (e.kind === 'USAGE' || e.kind === 'USAGE_REVERSAL') && toUtcDay(e.effectiveDate) > after,
    )
    .reduce((sum, e) => sum - e.minutes, 0)
}

function sortedByDay(entries: readonly ExistingEntry[]): ExistingEntry[] {
  // Stable, so entries on one day keep the order the projection wrote them in.
  return [...entries].sort((a, b) => toUtcDay(a.effectiveDate) - toUtcDay(b.effectiveDate))
}
