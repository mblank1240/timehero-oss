/**
 * Balance arithmetic over ledger entries.
 *
 * A balance is `SUM(minutes)` and nothing else (rule 2 in CLAUDE.md). There is
 * no stored total to drift out of step, and because minutes are integers the
 * result is exact — two balances are safe to compare with `===`.
 *
 * This is the pure form, over entries already in hand. The database-backed
 * `balanceAsOf(employeeId, leaveTypeId, date)` lives in `lib/ledger/balance.ts`
 * and is a plain aggregate: ordinary balance reads never replay anything.
 */

import { toUtcDay } from './dates'
import type { ExistingEntry, LedgerEntryKind } from './types'

/**
 * The balance on `asOf`, counting every entry effective on or before that day.
 * Entries dated later are ignored, which is what makes a projected balance and
 * a historical one the same query.
 */
export function balanceOf(entries: readonly ExistingEntry[], asOf: Date): number {
  const limit = toUtcDay(asOf, 'asOf')

  let total = 0
  for (const entry of entries) {
    if (toUtcDay(entry.effectiveDate, 'effectiveDate') <= limit) total += entry.minutes
  }

  return total
}

/**
 * The total of one kind of entry within a closed date range — how much was
 * accrued this benefit year, how much was forfeited at the boundary. The
 * cumulative-target accrual formula is built on this.
 */
export function sumOfKind(
  entries: readonly ExistingEntry[],
  kind: LedgerEntryKind,
  range: { from: Date; through: Date },
): number {
  const from = toUtcDay(range.from, 'from')
  const through = toUtcDay(range.through, 'through')

  let total = 0
  for (const entry of entries) {
    if (entry.kind !== kind) continue
    const day = toUtcDay(entry.effectiveDate, 'effectiveDate')
    if (day >= from && day <= through) total += entry.minutes
  }

  return total
}
