/**
 * Reading what a timesheet's grid is drawn from.
 *
 * One loader for the page, the service and the export, so that all three hand
 * `buildGrid` the same rows. Whether leave and holidays are read live or from
 * the frozen entries follows the timesheet's status: live while the employee
 * can still edit it, frozen from submission on.
 */

import type { Prisma } from '@prisma/client'

import { addDays } from '@/lib/accrual/dates'
import { db } from '@/lib/db'
import { orgSettingsOrThrow } from '@/lib/ledger/policies'

import { buildGrid, liveLines, type GridInput, type HolidayLine, type LeaveLine } from './grid'
import { workweekStart } from './overtime'

type Client = Prisma.TransactionClient | typeof db

export const EDITABLE_STATUSES = ['OPEN', 'REJECTED'] as const

export function isEditable(status: string): boolean {
  return (EDITABLE_STATUSES as readonly string[]).includes(status)
}

const SHEET_SELECT = {
  id: true,
  status: true,
  employeeId: true,
  payPeriodId: true,
  employee: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      hireDate: true,
      terminationDate: true,
      standardMinutesPerDay: true,
    },
  },
  payPeriod: { select: { id: true, startDate: true, endDate: true, payDate: true } },
} as const

export type SheetHead = Prisma.TimesheetGetPayload<{ select: typeof SHEET_SELECT }>

export async function sheetHead(timesheetId: string, client: Client = db) {
  return client.timesheet.findUnique({ where: { id: timesheetId }, select: SHEET_SELECT })
}

/**
 * When each timesheet was first submitted: its earliest approval step, since
 * steps are only ever created by a submission and never deleted. The
 * timesheet's own `submittedAt` is the latest submission.
 */
export async function firstSubmissions(
  timesheetIds: readonly string[],
  client: Client = db,
): Promise<Map<string, Date>> {
  if (timesheetIds.length === 0) return new Map()
  const rows = await client.approvalStep.groupBy({
    by: ['timesheetId'],
    where: { timesheetId: { in: [...timesheetIds] } },
    _min: { createdAt: true },
  })
  return new Map(
    rows.flatMap((r) => (r.timesheetId && r._min.createdAt ? [[r.timesheetId, r._min.createdAt]] : [])),
  )
}

/** Approved leave and the holiday calendar for the period, as they stand now. */
export async function liveLinesFor(sheet: SheetHead, client: Client = db) {
  const { startDate, endDate } = sheet.payPeriod

  const days = await client.leaveRequestDay.findMany({
    where: {
      date: { gte: startDate, lte: endDate },
      leaveRequest: { employeeId: sheet.employeeId, status: 'APPROVED' },
    },
    select: {
      date: true,
      minutes: true,
      leaveRequest: {
        select: { id: true, leaveType: { select: { id: true, name: true } } },
      },
    },
    orderBy: { date: 'asc' },
  })
  const holidays = await client.holiday.findMany({
    where: { date: { gte: startDate, lte: endDate } },
    select: { date: true, minutes: true, name: true },
    orderBy: { date: 'asc' },
  })

  return liveLines({
    period: sheet.payPeriod,
    employee: sheet.employee,
    approvedLeave: days.map((d) => ({
      date: d.date,
      minutes: d.minutes,
      leaveRequestId: d.leaveRequest.id,
      leaveTypeId: d.leaveRequest.leaveType.id,
      leaveTypeName: d.leaveRequest.leaveType.name,
    })),
    holidays,
  })
}

/** The leave and holiday lines frozen into the timesheet at its last submission. */
async function frozenLines(
  sheet: SheetHead,
  client: Client,
): Promise<{ leave: LeaveLine[]; holidays: HolidayLine[] }> {
  const rows = await client.timeEntry.findMany({
    where: { timesheetId: sheet.id, category: { in: ['LEAVE', 'HOLIDAY'] } },
    select: {
      date: true,
      minutes: true,
      category: true,
      note: true,
      leaveRequestId: true,
      leaveType: { select: { id: true, name: true } },
    },
    orderBy: { date: 'asc' },
  })

  const leave: LeaveLine[] = []
  const holidays: HolidayLine[] = []
  for (const row of rows) {
    if (row.category === 'LEAVE' && row.leaveRequestId && row.leaveType) {
      leave.push({
        date: row.date,
        minutes: row.minutes,
        leaveRequestId: row.leaveRequestId,
        leaveTypeId: row.leaveType.id,
        leaveTypeName: row.leaveType.name,
      })
    } else if (row.category === 'HOLIDAY') {
      holidays.push({ date: row.date, minutes: row.minutes, name: row.note ?? 'Holiday' })
    }
  }
  return { leave, holidays }
}

/** Everything `buildGrid` needs for one timesheet. */
export async function gridInputFor(
  sheet: SheetHead,
  client: Client = db,
): Promise<GridInput> {
  const org = await orgSettingsOrThrow()
  const rules = {
    thresholdMinutes: org.overtimeWeeklyThresholdMinutes,
    weekStartDay: org.workweekStartDay,
  }
  const { startDate, endDate } = sheet.payPeriod

  // Sequential queries: one connection per transaction.
  const worked = await client.timeEntry.findMany({
    where: { timesheetId: sheet.id, category: 'REGULAR' },
    select: { date: true, minutes: true, note: true },
    orderBy: { date: 'asc' },
  })

  // The first workweek may begin on the previous period's timesheet.
  const reach = workweekStart(startDate, rules.weekStartDay)
  const workedBefore =
    reach < startDate
      ? await client.timeEntry.findMany({
          where: {
            category: 'REGULAR',
            date: { gte: reach, lte: addDays(startDate, -1) },
            timesheet: { employeeId: sheet.employeeId },
          },
          select: { date: true, minutes: true },
        })
      : []

  const lines = isEditable(sheet.status)
    ? await liveLinesFor(sheet, client)
    : await frozenLines(sheet, client)

  return {
    period: { startDate, endDate },
    employee: sheet.employee,
    worked,
    workedBefore,
    leave: lines.leave,
    holidays: lines.holidays,
    rules,
  }
}

export async function gridFor(sheet: SheetHead, client: Client = db) {
  return buildGrid(await gridInputFor(sheet, client))
}
