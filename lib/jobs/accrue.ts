/**
 * The daily accrual job.
 *
 * It does two things, because both answer the same question — does this
 * employee have everything they are owed as of today?
 *
 *  1. **Lump grants due.** One `LUMP_GRANT` per employee, leave type and
 *     benefit year, on `max(benefitYearStart, hireDate + waitingPeriodDays)`.
 *     The rollover job writes these for everyone on the first day of the year,
 *     but it cannot know about someone hired in March, so the daily run picks
 *     them up on the day their waiting period ends.
 *  2. **Pay periods closing today.** The cumulative-target accrual for every
 *     period whose end date is `asOf`.
 *
 * Both are idempotent on their period key, so a retry, a manual trigger during
 * a scheduled run, or a backfill for a past date grants nothing twice.
 */

import { benefitYearContaining } from '@/lib/accrual/dates'
import { grantLump } from '@/lib/accrual/grant'
import { accruePayPeriod } from '@/lib/accrual/period'
import type { ProposedEntry } from '@/lib/accrual/types'
import { db } from '@/lib/db'
import { entriesByLeaveType, writeEntries } from '@/lib/ledger/entries'
import { orgSettingsOrThrow, subjectsForAccrual } from '@/lib/ledger/policies'
import type { PayScheduleInput } from '@/lib/payperiods/generate'

import type { JobOutcome, JobRunContext } from './runner'

export async function runAccrual(asOf: Date, run: JobRunContext): Promise<JobOutcome> {
  const org = await orgSettingsOrThrow()
  const subjects = await subjectsForAccrual(asOf)

  // Periods that close today. The job is written against the end date because
  // a period is earned by being completed.
  const closingPeriods = await db.payPeriod.findMany({
    where: { endDate: asOf },
    select: {
      id: true,
      startDate: true,
      endDate: true,
      payScheduleId: true,
      paySchedule: { select: { type: true, anchorDate: true, payDateOffsetDays: true } },
    },
  })

  const proposed: ProposedEntry[] = []
  let lumpGrants = 0
  let periodAccruals = 0
  const unscheduled = new Set<string>()

  for (const subject of subjects) {
    const { employee, policies } = subject
    if (policies.length === 0) continue

    const ledger = await entriesByLeaveType(employee.id)

    for (const { policy } of policies) {
      const entries = ledger.get(policy.leaveTypeId) ?? []

      if (policy.method === 'ANNUAL_LUMP') {
        const year = benefitYearContaining(asOf, org.benefitYearStartMonth, org.benefitYearStartDay)
        const grant = grantLump(employee, policy, year)
        // Only once it is actually due. A future-dated grant written by the
        // rollover job is fine — a balance ignores entries dated ahead — but
        // this job has no reason to write one early.
        if (grant && grant.effectiveDate <= asOf) {
          proposed.push(grant)
          lumpGrants += 1
        }
        continue
      }

      // A per-pay-period policy needs a pay schedule to divide the year by.
      // Without one nothing would ever accrue, silently, so it is counted and
      // reported rather than skipped quietly.
      if (!subject.payScheduleId) {
        unscheduled.add(employee.id)
        continue
      }

      for (const period of closingPeriods) {
        if (period.payScheduleId !== subject.payScheduleId) continue

        const schedule: PayScheduleInput = {
          type: period.paySchedule.type,
          anchorDate: period.paySchedule.anchorDate,
          payDateOffsetDays: period.paySchedule.payDateOffsetDays,
        }

        const accrual = accruePayPeriod({
          employee,
          policy,
          // A period belongs to the benefit year containing its end date.
          benefitYear: benefitYearContaining(
            period.endDate,
            org.benefitYearStartMonth,
            org.benefitYearStartDay,
          ),
          schedule,
          period: { startDate: period.startDate, endDate: period.endDate },
          entries,
        })

        if (accrual) {
          proposed.push(accrual)
          periodAccruals += 1
        }
      }
    }
  }

  const entriesCreated = await writeEntries(proposed, { jobRunId: run.jobRunId })

  return {
    entriesCreated,
    detail: {
      employeesConsidered: subjects.length,
      periodsClosing: closingPeriods.length,
      lumpGrantsProposed: lumpGrants,
      periodAccrualsProposed: periodAccruals,
      employeesOnAPerPeriodPolicyWithNoPaySchedule: unscheduled.size,
      // A gap between proposed and created is the idempotency key doing its
      // job, not a failure — it is what a second run looks like.
      skippedAsAlreadyWritten: lumpGrants + periodAccruals - entriesCreated,
    },
  }
}
