/**
 * The daily lot-expiry job.
 *
 * Carried comp time, and anything else granted with an `expiresOn`, stops
 * being spendable the day after it. This posts the `FORFEIT` for whatever was
 * left, keyed to the lot so one grant can only ever expire once.
 *
 * Only employees who actually hold an expired lot are loaded — most days that
 * is nobody, and the job should cost nothing on those days.
 */

import { expireLots } from '@/lib/accrual/expiry'
import type { ProposedEntry } from '@/lib/accrual/types'
import { db } from '@/lib/db'
import { entriesFor, writeEntries } from '@/lib/ledger/entries'

import type { JobOutcome, JobRunContext } from './runner'

export async function runExpireLots(asOf: Date, run: JobRunContext): Promise<JobOutcome> {
  // Candidates, not conclusions: a lot past its expiry date may well have been
  // spent in full. Only the ledger replay knows, and this narrows what has to
  // be replayed.
  const candidates = await db.ledgerEntry.findMany({
    where: { expiresOn: { lt: asOf }, minutes: { gt: 0 } },
    select: { employeeId: true, leaveTypeId: true },
    distinct: ['employeeId', 'leaveTypeId'],
  })

  const proposed: ProposedEntry[] = []

  for (const candidate of candidates) {
    const entries = await entriesFor(candidate.employeeId, candidate.leaveTypeId)

    proposed.push(
      ...expireLots({
        employee: { id: candidate.employeeId },
        leaveTypeId: candidate.leaveTypeId,
        entries,
        asOf,
      }),
    )
  }

  const entriesCreated = await writeEntries(proposed, { jobRunId: run.jobRunId })

  return {
    entriesCreated,
    detail: {
      accountsChecked: candidates.length,
      forfeitsProposed: proposed.length,
      minutesForfeited: -proposed.reduce((sum, e) => sum + e.minutes, 0),
      skippedAsAlreadyWritten: proposed.length - entriesCreated,
    },
  }
}
