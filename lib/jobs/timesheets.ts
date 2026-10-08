/**
 * The daily timesheet-creation job.
 *
 * Every hourly employee gets one timesheet per pay period of their schedule,
 * created while the period is open — any period containing the date the job
 * acts on. The `(employeeId, payPeriodId)` unique index is what makes a daily
 * re-run safe (rule 3): `skipDuplicates` lets the database refuse a second
 * copy, rather than the job remembering to check. Run it for a past date and
 * it creates whatever that day's run would have.
 *
 * Someone hired, moved to hourly or given a schedule part-way through a period
 * gets theirs on the next run, while the period is still open.
 */

import { db } from '@/lib/db'

import type { JobOutcome } from './runner'

export async function runCreateTimesheets(asOf: Date): Promise<JobOutcome> {
  const periods = await db.payPeriod.findMany({
    where: {
      startDate: { lte: asOf },
      endDate: { gte: asOf },
      paySchedule: { isActive: true },
    },
    select: { id: true, payScheduleId: true, startDate: true, endDate: true },
  })

  const rows: { employeeId: string; payPeriodId: string }[] = []

  for (const period of periods) {
    const employees = await db.employee.findMany({
      where: {
        employmentType: 'HOURLY',
        isActive: true,
        payScheduleId: period.payScheduleId,
        hireDate: { lte: period.endDate },
        OR: [{ terminationDate: null }, { terminationDate: { gte: period.startDate } }],
      },
      select: { id: true },
    })
    rows.push(...employees.map((e) => ({ employeeId: e.id, payPeriodId: period.id })))
  }

  // Reported rather than skipped quietly: an hourly employee with no schedule
  // would never get a timesheet, and nobody would notice until payday.
  const unscheduled = await db.employee.count({
    where: { employmentType: 'HOURLY', isActive: true, payScheduleId: null },
  })

  const { count } = rows.length
    ? await db.timesheet.createMany({ data: rows, skipDuplicates: true })
    : { count: 0 }

  return {
    entriesCreated: count,
    detail: {
      openPeriods: periods.length,
      timesheetsDue: rows.length,
      skippedAsAlreadyCreated: rows.length - count,
      hourlyWithoutPaySchedule: unscheduled,
    },
  }
}
