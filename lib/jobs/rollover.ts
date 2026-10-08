/**
 * The benefit-year rollover job.
 *
 * Runs daily and acts once a year — on the benefit year's start date, or on
 * the first run after it if that one was missed. That is deliberate: a job
 * that only runs on January 1 is a job nobody notices has failed until the
 * following January, whereas a daily run is visible in `JobRun` every morning.
 *
 * **Catching up.** GitHub's cron is best-effort and a self-hosted scheduler can
 * be down, so a rollover that waited for one particular date could simply
 * never happen, with every later run reporting a healthy skip. Instead a run on
 * any later day of the year checks the run log for a successful rollover into
 * this year and, finding none, does it then. The figures do not depend on the
 * day it runs: the closing balance is read as of the old year's last day, the
 * entries are dated the new year's first day, and the employees are the ones
 * employed on it. It reaches back one boundary only — the one that opened the
 * year `asOf` falls in. An older one is recovered by running the job for that
 * year's first day, which is what an explicit date is for.
 *
 * **Settling the closing year first.** Within a year a missed accrual run costs
 * nothing, because the next period's cumulative target catches it up; the
 * year's last period has no next period, so it is settled here, in the same
 * transaction and before the closing balance is read (`settleBenefitYear`).
 * Doing it in the accrual job instead would race this one: an accrual written
 * into a closed year after its rollover leaves the forfeit and the carry stale.
 *
 * The whole sequence for one employee and leave type — settle, forfeit the
 * closing balance, re-grant what is kept, then this year's lump grant — is
 * written in one transaction. A half-applied rollover would leave someone's
 * balance at zero.
 */

import { addDays, benefitYearContaining, isSameDay } from '@/lib/accrual/dates'
import { settleBenefitYear } from '@/lib/accrual/period'
import { runRollover } from '@/lib/accrual/rollover'
import type { ExistingEntry, ProposedEntry } from '@/lib/accrual/types'
import { db } from '@/lib/db'
import { formatDuration } from '@/lib/duration'
import { entriesByLeaveType, writeEntries } from '@/lib/ledger/entries'
import {
  orgSettingsOrThrow,
  rolloverConfiguration,
  subjectsForAccrual,
} from '@/lib/ledger/policies'
import { createNotifications } from '@/lib/notifications/notify'
import type { PayScheduleInput } from '@/lib/payperiods/generate'

import { rolloverRunFor } from './rollover-log'
import { describeFailure, throwIfFailures, type JobOutcome, type JobRunContext } from './runner'

export async function runBenefitYearRollover(asOf: Date, run: JobRunContext): Promise<JobOutcome> {
  const org = await orgSettingsOrThrow()

  const newYear = benefitYearContaining(asOf, org.benefitYearStartMonth, org.benefitYearStartDay)
  const onTheDay = isSameDay(asOf, newYear.start)

  // On the first day itself the job always acts — a re-run is a no-op, and an
  // administrator re-running it is asking for exactly that check. On any later
  // day it acts only if no run has rolled this year over yet.
  if (!onTheDay) {
    const done = await rolloverRunFor(newYear.label)
    if (done) {
      return {
        entriesCreated: 0,
        detail: {
          skipped: 'already rolled over',
          benefitYear: newYear.label,
          benefitYearStarted: newYear.start,
          rolledOverByRun: done.id,
        },
      }
    }
  }

  const closingYear = benefitYearContaining(
    addDays(newYear.start, -1),
    org.benefitYearStartMonth,
    org.benefitYearStartDay,
  )

  const leaveTypes = await rolloverConfiguration()
  // Employed on the boundary, with the policies in force on it — the same
  // people and policies whichever day the run happens on.
  const subjects = await subjectsForAccrual(newYear.start)
  // The policies in force on the closing year's last day, for settling it.
  const closingSubjects = new Map(
    (await subjectsForAccrual(closingYear.end)).map((s) => [s.employee.id, s]),
  )
  const schedules = new Map<string, PayScheduleInput>(
    (
      await db.paySchedule.findMany({
        select: { id: true, type: true, anchorDate: true, payDateOffsetDays: true },
      })
    ).map(({ id, ...schedule }) => [id, schedule]),
  )

  let entriesCreated = 0
  let forfeited = 0
  let carried = 0
  let stale = 0
  let settled = 0
  let untracked = 0
  const failures: string[] = []

  for (const subject of subjects) {
    const { employee, policies } = subject
    const ledger = await entriesByLeaveType(employee.id)
    const closing = closingSubjects.get(employee.id)

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
        const settlement = settleClosingYear(closing, leaveType.id, schedules, entries, closingYear)
        const settling: ProposedEntry[] = []
        if (settlement.status === 'settled') settling.push(settlement.entry)
        if (settlement.status === 'untracked') untracked += 1

        const result = runRollover({
          employee,
          leaveType: { id: leaveType.id, countsTowardRollover: leaveType.countsTowardRollover },
          rule: leaveType.rolloverRule,
          windows: leaveType.carryoverWindows,
          // Only a lump policy produces a grant here; `grantLump` ignores the
          // rest, so a per-pay-period type is handled by the daily accrual.
          policy: assigned?.policy ?? null,
          // The rollover reads the closing balance with the settlement on it.
          entries: [...entries, ...settling.map(asExisting)],
          closingYear,
          newYear,
        })

        const toWrite = [...settling, ...result.entries]
        if (toWrite.length === 0) continue

        stale += countStale(toWrite, entries)

        // One transaction per employee and leave type. The settlement, the
        // forfeit and the re-grant must never be separable; different
        // employees are independent.
        await db.$transaction(async (tx) => {
          entriesCreated += await writeEntries(toWrite, { jobRunId: run.jobRunId }, tx)
        })

        settled += settling.length
        forfeited += result.forfeitedMinutes
        carried += result.baseCarryMinutes + result.windowCarryMinutes
      } catch (error) {
        failures.push(describeFailure(`${employee.id}/${leaveType.code}`, error))
      }
    }
  }

  const detail = {
    closingYear: closingYear.label,
    // What `rolloverRunFor` looks for. Only a run that acted records it.
    newYear: newYear.label,
    // Run after the year's first day because that day's run was missed.
    caughtUp: !onTheDay,
    employeesProcessed: subjects.length,
    leaveTypesProcessed: leaveTypes.length,
    minutesForfeited: forfeited,
    minutesCarried: carried,
    finalAccrualsSettled: settled,
    // See `settleBenefitYear`. Non-zero needs a human and an ADJUSTMENT.
    finalAccrualsUntracked: untracked,
    // See `countStale`. Non-zero needs a human and an ADJUSTMENT.
    rolloversNeedingCorrection: stale,
    failures: failures.length,
  }

  await notifyAdministrators(detail)

  // Fails the run — and the workflow — while leaving everything that did
  // succeed in place. With no successful run recorded for the year, the next
  // daily run tries again and picks up only what is missing.
  throwIfFailures('rollover(s)', failures)

  return { entriesCreated, detail }
}

/**
 * The closing year's missing last-period accrual, for one employee and type,
 * under the policy that was in force on the year's last day. Only a
 * per-pay-period policy with a pay schedule has one to settle.
 */
function settleClosingYear(
  closing: Awaited<ReturnType<typeof subjectsForAccrual>>[number] | undefined,
  leaveTypeId: string,
  schedules: ReadonlyMap<string, PayScheduleInput>,
  entries: readonly ExistingEntry[],
  closingYear: ReturnType<typeof benefitYearContaining>,
) {
  const policy = closing?.policies.find((p) => p.policy.leaveTypeId === leaveTypeId)?.policy
  const schedule = closing?.payScheduleId ? schedules.get(closing.payScheduleId) : undefined
  if (!closing || !policy || policy.method !== 'PER_PAY_PERIOD' || !schedule) {
    return { status: 'complete' } as const
  }

  return settleBenefitYear({
    employee: closing.employee,
    policy,
    benefitYear: closingYear,
    schedule,
    entries,
  })
}

/** A proposed entry as the rollover reads one, before it is written. */
function asExisting(entry: ProposedEntry, index: number): ExistingEntry {
  return {
    // Sorts after every real cuid on the same day, like a projected row.
    id: `~settlement-${index}`,
    effectiveDate: entry.effectiveDate,
    minutes: entry.minutes,
    kind: entry.kind,
    expiresOn: entry.expiresOn,
    periodKey: entry.periodKey,
  }
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
 * The rollover settling the closing year's last period itself closes the
 * commonest route to that — a missed accrual run on the year's last pay day —
 * but not every one: a backfill under a policy edited since, or anything else
 * dated into the closed year after the fact, still lands here.
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
  finalAccrualsUntracked: number
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
    detail.finalAccrualsUntracked > 0 &&
      `${detail.finalAccrualsUntracked} final pay-period accrual(s) for ${detail.closingYear} were not settled automatically because the ledger has nothing for that year`,
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
