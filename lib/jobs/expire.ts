/**
 * The daily lot-expiry job.
 *
 * Carried comp time, and anything else granted with an `expiresOn`, stops
 * being spendable the day after it. This posts the `FORFEIT` for whatever was
 * left, keyed to the lot so one grant can only ever expire once.
 *
 * Only employees who actually hold an expired lot are loaded — most days that
 * is nobody, and the job should cost nothing on those days.
 *
 * Each account is written separately and a failure is collected rather than
 * thrown, like the rollover: one bad ledger must not keep everyone else's
 * expired time on the books. The run is failed at the end if any was skipped.
 *
 * Pending leave requests are not consulted. A request submitted against a lot
 * that has since expired is caught when it is approved — the final balance
 * check reads this job's forfeit along with everything else (see
 * `firstShortfall`) — rather than by holding expired time back here.
 */

import { expireLots } from '@/lib/accrual/expiry'
import { db } from '@/lib/db'
import { entriesFor, writeEntries } from '@/lib/ledger/entries'

import { describeFailure, throwIfFailures, type JobOutcome, type JobRunContext } from './runner'

export async function runExpireLots(asOf: Date, run: JobRunContext): Promise<JobOutcome> {
  // Candidates, not conclusions: a lot past its expiry date may well have been
  // spent in full. Only the ledger replay knows, and this narrows what has to
  // be replayed.
  const candidates = await db.ledgerEntry.findMany({
    where: { expiresOn: { lt: asOf }, minutes: { gt: 0 } },
    select: { employeeId: true, leaveTypeId: true },
    distinct: ['employeeId', 'leaveTypeId'],
  })

  let entriesCreated = 0
  let proposed = 0
  let minutesForfeited = 0
  const failures: string[] = []

  for (const candidate of candidates) {
    try {
      const entries = await entriesFor(candidate.employeeId, candidate.leaveTypeId)

      const forfeits = expireLots({
        employee: { id: candidate.employeeId },
        leaveTypeId: candidate.leaveTypeId,
        entries,
        asOf,
      })

      entriesCreated += await writeEntries(forfeits, { jobRunId: run.jobRunId })
      proposed += forfeits.length
      minutesForfeited -= forfeits.reduce((sum, e) => sum + e.minutes, 0)
    } catch (error) {
      failures.push(describeFailure(`${candidate.employeeId}/${candidate.leaveTypeId}`, error))
    }
  }

  throwIfFailures('lot expiries', failures)

  return {
    entriesCreated,
    detail: {
      accountsChecked: candidates.length,
      forfeitsProposed: proposed,
      minutesForfeited,
      skippedAsAlreadyWritten: proposed - entriesCreated,
    },
  }
}
