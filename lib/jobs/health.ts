/**
 * Missed-run detection.
 *
 * A failed job turns the workflow red and somebody hears about it. A job that
 * silently stops — the cron disabled after sixty days without a commit, the
 * secret rotated on one side only, the workflow file broken — produces no
 * failure at all, just an absence. That is the failure most likely to go
 * unnoticed for a year, so absence is checked for directly: each job's last
 * success against how often it is meant to run.
 *
 * `overdueJobs` is pure; `jobHealth` reads the run log. Both the Admin → Jobs
 * page and `/api/health/jobs` (which an Azure availability alert polls) use it.
 */

import { db } from '@/lib/db'

import { JOB_CADENCE, JOB_NAMES, type Cadence, type JobName } from './catalog'

const HOUR = 60 * 60 * 1000

/**
 * How long after a job's last success it counts as missed. Generous on
 * purpose: GitHub's scheduled triggers routinely start late under load, and an
 * alert that cries wolf gets muted.
 */
export const GRACE_MS: Record<Cadence, number> = {
  hourly: 3 * HOUR,
  daily: 30 * HOUR,
  weekly: 8 * 24 * HOUR,
}

export type OverdueJob = {
  jobName: JobName
  cadence: Cadence
  /** Null when the job has never succeeded. */
  lastSucceededAt: Date | null
}

export function overdueJobs(
  lastSucceeded: ReadonlyMap<string, Date>,
  now: Date,
  cadence: Record<JobName, Cadence> = JOB_CADENCE,
): OverdueJob[] {
  const overdue: OverdueJob[] = []
  for (const jobName of JOB_NAMES) {
    const last = lastSucceeded.get(jobName) ?? null
    if (last && now.getTime() - last.getTime() <= GRACE_MS[cadence[jobName]]) continue
    overdue.push({ jobName, cadence: cadence[jobName], lastSucceededAt: last })
  }
  return overdue
}

/** Each job's latest success, from the run log. */
export async function lastSuccesses(): Promise<Map<string, Date>> {
  const rows = await db.jobRun.groupBy({
    by: ['jobName'],
    where: { status: 'SUCCEEDED' },
    _max: { finishedAt: true },
  })
  const map = new Map<string, Date>()
  for (const row of rows) if (row._max.finishedAt) map.set(row.jobName, row._max.finishedAt)
  return map
}

export async function jobHealth(now: Date = new Date()): Promise<OverdueJob[]> {
  return overdueJobs(await lastSuccesses(), now)
}
