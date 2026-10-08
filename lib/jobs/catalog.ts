/**
 * The jobs that exist, and how to run one by name.
 *
 * Shared by the scheduled route (`/api/jobs/<name>`), the admin screen's "run
 * now" action, and the screen itself. One registry rather than three means a
 * job cannot be reachable from the cron but missing from the UI, and the names
 * in the run log always match the names on the page.
 *
 * Deliberately not a `'use server'` module: it exports data as well as
 * functions, which a server-action file may not do.
 */

import { runDirectorySync } from '@/lib/directory/sync'
import { syncAllPaySchedules } from '@/lib/payperiods/sync'

import { runAccrual } from './accrue'
import { runExpireLots } from './expire'
import { runSendNotifications } from './notifications'
import { runBenefitYearRollover } from './rollover'
import type { JobOutcome, JobRunContext } from './runner'
import { runCreateTimesheets } from './timesheets'

export const JOB_NAMES = [
  'accrue-pay-period',
  'benefit-year-rollover',
  'create-timesheets',
  'expire-lots',
  'generate-pay-periods',
  'send-notifications',
  'sync-directory',
] as const

export type JobName = (typeof JOB_NAMES)[number]

export const JOB_DESCRIPTIONS: Record<JobName, string> = {
  'accrue-pay-period':
    'Daily. Grants any lump allotments that have come due, and accrues every pay period ending on the date.',
  'benefit-year-rollover':
    'Daily, but does nothing except on the first day of the benefit year, when it forfeits closing balances, re-grants what is carried, and posts the new year’s allotments.',
  'create-timesheets':
    'Daily. Creates a timesheet for every hourly employee in each pay period open on the date.',
  'expire-lots': 'Daily. Forfeits whatever is left of any grant that has passed its expiry date.',
  'generate-pay-periods': 'Weekly. Keeps 24 months of pay periods generated ahead of today.',
  'send-notifications':
    'Hourly. Sends approval reminders as they escalate, timesheet due and overdue reminders and approvers’ daily digests, then delivers anything still waiting to go out by push or email.',
  'sync-directory':
    'Daily. Imports and links active staff from the organization’s registered directory, and flags anyone whose account has been disabled. Does nothing until a directory is connected.',
}

/**
 * How often each job is scheduled in `.github/workflows/jobs.yml`. Missed-run
 * detection (`lib/jobs/health.ts`) reads this; keep the two in step.
 */
export const JOB_CADENCE: Record<JobName, Cadence> = {
  'accrue-pay-period': 'daily',
  'benefit-year-rollover': 'daily',
  'create-timesheets': 'daily',
  'expire-lots': 'daily',
  'generate-pay-periods': 'weekly',
  'send-notifications': 'hourly',
  'sync-directory': 'daily',
}

export type Cadence = 'hourly' | 'daily' | 'weekly'

/** Every job takes the date it acts on and the run it is part of. */
type Job = (asOf: Date, run: JobRunContext) => Promise<JobOutcome>

const JOBS: Record<JobName, Job> = {
  'sync-directory': (asOf) => runDirectorySync(asOf),
  'accrue-pay-period': runAccrual,
  'benefit-year-rollover': runBenefitYearRollover,
  'create-timesheets': runCreateTimesheets,
  'expire-lots': runExpireLots,
  'send-notifications': runSendNotifications,
  'generate-pay-periods': async (asOf) => {
    const results = await syncAllPaySchedules({ asOf })
    return {
      // Pay periods are not ledger entries, but the count is what the run log
      // is for: how much this execution actually changed.
      entriesCreated: results.reduce((sum, r) => sum + r.created, 0),
      detail: { schedules: results },
    }
  },
}

export function isJobName(name: string): name is JobName {
  return (JOB_NAMES as readonly string[]).includes(name)
}

export function jobByName(name: JobName): Job {
  return JOBS[name]
}
