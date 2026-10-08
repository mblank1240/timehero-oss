/**
 * Lot tracking: how much of a *particular* grant is left.
 *
 * A running balance cannot answer that. Someone who banked 16h of comp in
 * December, spent 8h in January and earned 4h in February has a balance of
 * 12h, but only 8h of it expires at the end of the grace period. Expiry and
 * rollover both need the per-grant figure, so this replays the ledger.
 *
 * **Consumption order is soonest `expiresOn` first (nulls last), then oldest
 * `effectiveDate`.** Not FIFO. Spending the time that is about to disappear
 * before the time that never will is what makes employees lose the least;
 * strict FIFO would burn permanent PTO while a February-expiring comp lot ran
 * out, which staff would rightly consider theft (docs/DECISIONS.md).
 *
 * This stays off the hot path. Only the expiry and rollover jobs pay for the
 * replay — ordinary balance reads are still a plain `SUM`.
 */

import { toUtcDay } from './dates'
import type { ExistingEntry, Lot } from './types'

export type LotBalances = {
  lots: Lot[]
  /**
   * Consumption that found no lot to draw from, as a positive number. Non-zero
   * means the employee went negative — possible for a leave type with
   * `allowsNegativeBalance`, or where usage predates the grant that covers it.
   */
  unappliedMinutes: number
}

/**
 * Replays `entries` up to `asOf` into lots with their unconsumed remainders.
 *
 * Entries are applied in date order, and within a day every grant lands before
 * any consumption — leave taken on the day it was granted draws on that grant
 * rather than overdrawing the account.
 */
export function lotBalances(entries: readonly ExistingEntry[], asOf: Date): LotBalances {
  const limit = toUtcDay(asOf, 'asOf')

  const ordered = entries
    .filter((e) => toUtcDay(e.effectiveDate, 'effectiveDate') <= limit)
    .slice()
    .sort(chronological)

  const lots: Lot[] = []
  let unappliedMinutes = 0

  for (const entry of ordered) {
    if (entry.minutes > 0) {
      lots.push({
        entryId: entry.id,
        effectiveDate: entry.effectiveDate,
        expiresOn: entry.expiresOn,
        kind: entry.kind,
        grantedMinutes: entry.minutes,
        remainingMinutes: entry.minutes,
      })
      continue
    }

    if (entry.minutes < 0) unappliedMinutes += consume(lots, -entry.minutes)
  }

  return { lots, unappliedMinutes }
}

/** The lots an entry may draw on, in the order it should draw on them. */
function consume(lots: Lot[], amount: number): number {
  let left = amount

  for (const lot of lots.slice().sort(consumptionOrder)) {
    if (left === 0) break
    const taken = Math.min(lot.remainingMinutes, left)
    lot.remainingMinutes -= taken
    left -= taken
  }

  // Whatever is left found nothing to draw on: the balance has gone negative.
  return left
}

/**
 * Date order, and within a day: forfeits, then grants, then everything else.
 *
 * Both halves of that matter, and the rollover is where they collide. A
 * benefit-year rollover writes a `FORFEIT` of the whole closing balance and a
 * `ROLLOVER_IN` of the carried amount, *both dated day 1 of the new year*. A
 * forfeit removes time that was already there, so it can only ever apply to
 * lots that predate it — if the new carried lot were created first, the
 * forfeit would consume it (it is the soonest-expiring thing in the account)
 * and leave the old balance sitting there unexpiring. The December comp lot
 * then never expires, which is exactly the bug this ordering prevents.
 *
 * Grants come before the rest, so leave taken on the day it was granted draws
 * on that grant rather than overdrawing the account.
 *
 * Ties break on the entry id so the replay is deterministic — two runs over
 * the same ledger must distribute consumption across lots identically, or a
 * forfeit would depend on the order the database happened to return rows in.
 */
function chronological(a: ExistingEntry, b: ExistingEntry): number {
  const byDate = toUtcDay(a.effectiveDate) - toUtcDay(b.effectiveDate)
  if (byDate !== 0) return byDate

  const byRank = sameDayRank(a) - sameDayRank(b)
  if (byRank !== 0) return byRank

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function sameDayRank(entry: ExistingEntry): number {
  if (entry.kind === 'FORFEIT') return 0
  if (entry.minutes > 0) return 1
  return 2
}

function consumptionOrder(a: Lot, b: Lot): number {
  // Nulls last: time that never expires is spent only once the expiring time
  // is gone.
  if (a.expiresOn === null && b.expiresOn !== null) return 1
  if (a.expiresOn !== null && b.expiresOn === null) return -1
  if (a.expiresOn !== null && b.expiresOn !== null) {
    const byExpiry = toUtcDay(a.expiresOn) - toUtcDay(b.expiresOn)
    if (byExpiry !== 0) return byExpiry
  }

  const byDate = toUtcDay(a.effectiveDate) - toUtcDay(b.effectiveDate)
  if (byDate !== 0) return byDate

  return a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0
}
