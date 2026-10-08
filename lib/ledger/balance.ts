/**
 * Balance reads.
 *
 * A balance is `SUM(minutes)` over the ledger and nothing else — there is no
 * stored total anywhere in the schema (rule 2 in CLAUDE.md). This is the hot
 * path, so it stays a plain aggregate; only the expiry and rollover jobs pay
 * for a lot replay.
 */

import { lotBalances } from '@/lib/accrual/lots'
import type { Lot } from '@/lib/accrual/types'
import { db } from '@/lib/db'

import { entriesByLeaveType, entriesFor } from './entries'

/**
 * The balance on `asOf`, in minutes. Entries dated later are excluded, which
 * is what makes a historical balance and a projected one the same query.
 */
export async function balanceAsOf(
  employeeId: string,
  leaveTypeId: string,
  asOf: Date,
): Promise<number> {
  const result = await db.ledgerEntry.aggregate({
    where: { employeeId, leaveTypeId, effectiveDate: { lte: asOf } },
    _sum: { minutes: true },
  })

  // No entries at all sums to null, which is a balance of zero.
  return result._sum.minutes ?? 0
}

/** Every leave type's balance for one employee, keyed by leave type id. */
export async function balancesAsOf(
  employeeId: string,
  asOf: Date,
): Promise<Map<string, number>> {
  const rows = await db.ledgerEntry.groupBy({
    by: ['leaveTypeId'],
    where: { employeeId, effectiveDate: { lte: asOf } },
    _sum: { minutes: true },
  })

  return new Map(rows.map((row) => [row.leaveTypeId, row._sum.minutes ?? 0]))
}

/**
 * Per-grant remainders. Needed by the expiry and rollover jobs, and by any
 * screen that has to say *why* a balance is about to drop.
 */
export async function lotsAsOf(
  employeeId: string,
  leaveTypeId: string,
  asOf: Date,
): Promise<Lot[]> {
  const entries = await entriesFor(employeeId, leaveTypeId)
  return lotBalances(entries, asOf).lots
}

/** Lots across every type, for the "expiring soon" view and the expiry job. */
export async function allLotsAsOf(employeeId: string, asOf: Date): Promise<Map<string, Lot[]>> {
  const byType = await entriesByLeaveType(employeeId)

  return new Map(
    [...byType.entries()].map(([leaveTypeId, entries]) => [
      leaveTypeId,
      lotBalances(entries, asOf).lots,
    ]),
  )
}
