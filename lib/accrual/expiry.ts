/**
 * Lot expiry.
 *
 * Grants that carry an `expiresOn` — carried comp time, a time-limited award —
 * stop being spendable the day after it. What is left of them has to leave the
 * balance, and the amount is per-lot, which only a ledger replay can answer:
 * someone who banked 16h of comp in December and spent 8h in January has 12h
 * of balance, of which 8h expires.
 *
 * Pure. The daily `expire-lots` job writes what this returns.
 */

import { addDays, toUtcDay } from './dates'
import { lotBalances } from './lots'
import type { EmployeeInput, ExistingEntry, ProposedEntry } from './types'

export type ExpireLotsArgs = {
  employee: Pick<EmployeeInput, 'id'>
  leaveTypeId: string
  /** Every ledger entry for this employee and leave type. */
  entries: readonly ExistingEntry[]
  /** Today, as the job sees it. A lot is still spendable on its expiry date. */
  asOf: Date
}

/**
 * A `FORFEIT` for every expired lot with something left in it.
 *
 * The remainder is measured as of `asOf` rather than as of the expiry date, so
 * a job that runs late forfeits what is actually still there instead of
 * double-counting time the employee managed to spend in the gap. On the
 * ordinary daily cadence the two are the same number.
 *
 * The entry is dated `expiresOn + 1` whatever day the job runs, so an
 * employee's history says when the time ran out rather than when a server got
 * round to noticing.
 */
export function expireLots(args: ExpireLotsArgs): ProposedEntry[] {
  const { employee, leaveTypeId, entries, asOf } = args
  const today = toUtcDay(asOf, 'asOf')

  const { lots } = lotBalances(entries, asOf)

  return lots
    .filter((lot) => lot.expiresOn !== null && toUtcDay(lot.expiresOn) < today)
    .filter((lot) => lot.remainingMinutes > 0)
    .map((lot) => ({
      employeeId: employee.id,
      leaveTypeId,
      // Non-null by the filter above; TypeScript cannot see across it.
      effectiveDate: addDays(lot.expiresOn as Date, 1),
      minutes: -lot.remainingMinutes,
      kind: 'FORFEIT' as const,
      expiresOn: null,
      // Keyed to the lot, not to a date: one expiry per grant, ever.
      periodKey: `${lot.entryId}-EXPIRY`,
      note: 'Expired',
      sourceType: 'LedgerEntry',
      sourceId: lot.entryId,
    }))
}
