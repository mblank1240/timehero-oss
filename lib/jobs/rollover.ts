/**
 * The benefit-year rollover job.
 *
 * Runs daily and does nothing on all but one day a year — the benefit year's
 * start date. That is deliberate: a job that only runs on January 1 is a job
 * nobody notices has failed until the following January, whereas a daily
 * no-op is visible in `JobRun` every morning.
 *
 * The whole sequence for one employee and leave type — forfeit the closing
 * balance, re-grant what is kept, then this year's lump grant — is written in
 * one transaction. A half-applied rollover would leave someone's balance at
 * zero.
 */

import { addDays, benefitYearContaining, isSameDay } from '@/lib/accrual/dates'
import { runRollover } from '@/lib/accrual/rollover'
import { db } from '@/lib/db'
import { formatDuration } from '@/lib/duration'
import { entriesByLeaveType, writeEntries } from '@/lib/ledger/entries'
import {
  orgSettingsOrThrow,
  rolloverConfiguration,
  subjectsForAccrual,
} from '@/lib/ledger/policies'
import { createNotifications } from '@/lib/notifications/notify'

import type { JobOutcome, JobRunContext } from './runner'

export async function runBenefitYearRollover(asOf: Date, run: JobRunContext): Promise<JobOutcome> {
  const org = await orgSettingsOrThrow()

  const newYear = benefitYearContaining(asOf, org.benefitYearStartMonth, org.benefitYearStartDay)

  // Any other day of the year, there is nothing to do.
  if (!isSameDay(asOf, newYear.start)) {
    return {
      entriesCreated: 0,
      detail: { skipped: 'not the benefit year start', benefitYearStarts: newYear.start },
    }
  }

  const closingYear = benefitYearContaining(
    addDays(newYear.start, -1),
    org.benefitYearStartMonth,
    org.benefitYearStartDay,
  )

  const leaveTypes = await rolloverConfiguration()
  const subjects = await subjectsForAccrual(asOf)

  let entriesCreated = 0
  let forfeited = 0
  let carried = 0
  let stale = 0
  const failures: string[] = []

  for (const subject of subjects) {
    const { employee, policies } = subject
    const ledger = await entriesByLeaveType(employee.id)

    for (const leaveType of leaveTypes) {
      const entries = ledger.get(leaveType.id) ?? []
      const assigned = policies.find((p) => p.policy.leaveTypeId === leaveType.id)

      // Nothing to carry and nothing to grant: skip rather than open a
      // transaction per employee per type for no reason.
      if (entries.length === 0 && !assigned) continue

      // One employee's bad configuration must not cost everyone else their
      // rollover. This runs once a year, so an exception that aborted the loop
      // would leave whoever came after it with no carry and no new allotment
      // until somebody noticed — the failures are collected and the run is
      // failed at the end instead, after the healthy employees are done.
      try {
        const result = runRollover({
          employee,
          leaveType: { id: leaveType.id, countsTowardRollover: leaveType.countsTowardRollover },
          rule: leaveType.rolloverRule,
          windows: leaveType.carryoverWindows,
          // Only a lump policy produces a grant here; `grantLump` ignores the
          // rest, so a per-pay-period type is handled by the daily accrual.
          policy: assigned?.policy ?? null,
          entries,
          closingYear,
          newYear,
        })

        if (result.entries.length === 0) continue

        stale += countStale(result.entries, entries)

        // One transaction per employee and leave type. The forfeit and the
        // re-grant must never be separable; different employees are
        // independent.
        await db.$transaction(async (tx) => {
          entriesCreated += await writeEntries(result.entries, { jobRunId: run.jobRunId }, tx)
        })

        forfeited += result.forfeitedMinutes
        carried += result.baseCarryMinutes + result.windowCarryMinutes
      } catch (error) {
        failures.push(
          `${employee.id}/${leaveType.code}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  const detail = {
    closingYear: closingYear.label,
    newYear: newYear.label,
    employeesProcessed: subjects.length,
    leaveTypesProcessed: leaveTypes.length,
    minutesForfeited: forfeited,
    minutesCarried: carried,
    // See `countStale`. Non-zero needs a human and an ADJUSTMENT.
    rolloversNeedingCorrection: stale,
    failures: failures.length,
  }

  await notifyAdministrators(detail)

  if (failures.length > 0) {
    // Fails the run — and the workflow — while leaving everything that did
    // succeed in place. Re-running once the configuration is fixed picks up
    // only what is missing.
    throw new Error(
      `${failures.length} rollover(s) failed: ${failures.slice(0, 5).join('; ')}` +
        (failures.length > 5 ? ` (and ${failures.length - 5} more)` : ''),
    )
  }

  return { entriesCreated, detail }
}

/**
 * Rollover entries whose idempotency key is already taken by a row with a
 * different amount.
 *
 * The forfeit and the carry are keyed `<year>-ROLLOVER`, so if a late accrual
 * for the old year is backfilled *after* the rollover has run, a re-run
 * recomputes larger figures and `skipDuplicates` silently drops every one of
 * them. The extra minutes are then neither forfeited nor carried, and the run
 * reports `entriesCreated: 0` exactly as a healthy no-op does.
 *
 * Rewriting history is not an option — the ledger is append-only — so the
 * discrepancy is counted and surfaced for an administrator to settle with an
 * `ADJUSTMENT`, rather than disappearing.
 */
function countStale(
  proposed: readonly { kind: string; periodKey: string | null; minutes: number }[],
  existing: readonly { kind: string; periodKey?: string | null; minutes: number }[],
): number {
  let stale = 0

  for (const entry of proposed) {
    if (!entry.periodKey) continue
    const current = existing.find(
      (e) => e.kind === entry.kind && e.periodKey === entry.periodKey,
    )
    if (current && current.minutes !== entry.minutes) stale += 1
  }

  return stale
}

/**
 * The year-end summary for administrators. Keyed by the new year, so a
 * re-run of the rollover does not announce it twice; sent whether or not
 * some employees failed, since that is exactly when someone needs to look.
 */
async function notifyAdministrators(detail: {
  closingYear: number
  newYear: number
  employeesProcessed: number
  minutesForfeited: number
  minutesCarried: number
  rolloversNeedingCorrection: number
  failures: number
}) {
  const admins = await db.employee.findMany({
    where: { role: 'ADMIN', isActive: true },
    select: { id: true },
  })
  const hours = (minutes: number) => formatDuration(minutes, { unit: 'HOURS', minutesPerDay: 1 })

  const problems = [
    detail.failures > 0 && `${detail.failures} failed and need attention in the job log`,
    detail.rolloversNeedingCorrection > 0 &&
      `${detail.rolloversNeedingCorrection} need a correcting adjustment`,
  ].filter(Boolean)

  await createNotifications(
    admins.map((admin) => ({
      recipientId: admin.id,
      type: 'ROLLOVER_SUMMARY' as const,
      key: `rollover:${detail.newYear}`,
      title: `Rollover into ${detail.newYear} ${detail.failures > 0 ? 'finished with failures' : 'done'}`,
      body:
        `The ${detail.closingYear} benefit year closed for ${detail.employeesProcessed} employees: ` +
        `${hours(detail.minutesForfeited)} forfeited, ${hours(detail.minutesCarried)} carried into ${detail.newYear}.` +
        (problems.length > 0 ? ` ${problems.join('; ')}.` : ''),
      url: detail.failures > 0 ? '/admin/jobs' : '/reports/forfeitures',
    })),
  )
}
