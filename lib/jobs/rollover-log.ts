/**
 * Whether a benefit year's rollover has been done, from the run log.
 *
 * Shared by the rollover job, which uses it to decide whether a run after the
 * year's first day still has a rollover to catch up, and by missed-run
 * detection, which uses it to notice a year that began without one. Its own
 * module because both of those import it and `catalog.ts` imports the job.
 */

import { db } from '@/lib/db'

import type { JobName } from './catalog'

export const ROLLOVER_JOB: JobName = 'benefit-year-rollover'

/**
 * The successful rollover run that opened benefit year `label`, or null.
 *
 * A run that acted records `newYear` in its detail; one that skipped records
 * nothing under that name, and a failed one is not `SUCCEEDED`. So a year with
 * only failures, or only skips, has not been rolled over — which is exactly
 * the case worth retrying and worth alarming on.
 */
export async function rolloverRunFor(label: number): Promise<{ id: string; finishedAt: Date | null } | null> {
  return db.jobRun.findFirst({
    where: {
      jobName: ROLLOVER_JOB,
      status: 'SUCCEEDED',
      detail: { path: ['newYear'], equals: label },
    },
    orderBy: { finishedAt: 'asc' },
    select: { id: true, finishedAt: true },
  })
}
