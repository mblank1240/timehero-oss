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
 * One absence a daily heartbeat cannot show: a benefit year that began with
 * no rollover. The rollover job succeeds every day, so its last success is
 * always recent; what matters once a year is whether any of those runs
 * actually rolled the year over. `missedRollover` asks that directly.
 *
 * `overdueJobs` and `missedRollover` are pure; `jobHealth` reads the run log.
 * Both the Admin → Jobs page and `/api/health/jobs` (which an Azure
 * availability alert polls) use it.
 */

import { addDays, benefitYearContaining, todayIn } from '@/lib/accrual/dates'
import { db } from '@/lib/db'

import { JOB_CADENCE, JOB_NAMES, type Cadence, type JobName } from './catalog'
import { ROLLOVER_JOB, rolloverRunFor } from './rollover-log'

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
  /** Set when the job is running but has not done what it is for. */
  reason?: string
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

/**
 * True once a benefit year is a day old with no rollover into it.
 *
 * The rollover job catches up on its own — any run after the first day acts if
 * none has — so this is only ever true when the job is not running at all, or
 * keeps failing. The first day itself is allowed: the run may simply not have
 * fired yet.
 */
export function missedRollover(args: {
  today: Date
  yearStart: Date
  rolledOver: boolean
}): boolean {
  return !args.rolledOver && args.today.getTime() >= addDays(args.yearStart, 1).getTime()
}

export async function jobHealth(now: Date = new Date()): Promise<OverdueJob[]> {
  const successes = await lastSuccesses()
  const overdue = overdueJobs(successes, now)

  if (!overdue.some((job) => job.jobName === ROLLOVER_JOB)) {
    const reason = await rolloverOutstanding(now)
    if (reason) {
      overdue.push({
        jobName: ROLLOVER_JOB,
        cadence: JOB_CADENCE[ROLLOVER_JOB],
        lastSucceededAt: successes.get(ROLLOVER_JOB) ?? null,
        reason,
      })
    }
  }

  return overdue
}

/** Why the current benefit year's rollover counts as missed, or null. */
async function rolloverOutstanding(now: Date): Promise<string | null> {
  const org = await db.orgSettings.findUnique({
    where: { id: 1 },
    select: { timezone: true, benefitYearStartMonth: true, benefitYearStartDay: true },
  })
  // Unconfigured: nothing has a benefit year yet, and the jobs say so loudly
  // enough on their own.
  if (!org) return null

  const today = todayIn(org.timezone, now)
  const year = benefitYearContaining(today, org.benefitYearStartMonth, org.benefitYearStartDay)
  const rolledOver = (await rolloverRunFor(year.label)) !== null

  if (!missedRollover({ today, yearStart: year.start, rolledOver })) return null
  return `The ${year.label} benefit year began on ${year.start.toISOString().slice(0, 10)} and has not been rolled over.`
}
