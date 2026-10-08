/**
 * One pay period's timesheets, for the administrators' status grid and the
 * payroll export.
 *
 * Every hourly employee who should have a timesheet for the period is listed,
 * including anyone whose timesheet has not been created — a missing row is
 * exactly what the grid is for spotting. Totals come from the same
 * `buildGrid` the timesheet page draws, so the export cannot disagree with
 * what was approved.
 */

import { db } from '@/lib/db'
import type { CsvCell } from '@/lib/csv'
import { orgSettingsOrThrow } from '@/lib/ledger/policies'

import { firstSubmissions, gridFor, sheetHead, type SheetHead } from './data'
import { timeliness, timesheetDueDate, type Timeliness } from './due'
import type { Grid, GridTotals } from './grid'

export type PeriodRow = {
  employee: { id: string; firstName: string; lastName: string; email: string }
  timesheetId: string | null
  status: 'OPEN' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | null
  totals: GridTotals | null
  /** Null when there is no timesheet to judge. */
  timeliness: Timeliness | null
  firstSubmittedAt: Date | null
  /** The whole grid, for the per-employee export. */
  grid: Grid | null
}

export async function periodReport(payPeriodId: string, now: Date = new Date()) {
  const org = await orgSettingsOrThrow()
  const period = await db.payPeriod.findUnique({
    where: { id: payPeriodId },
    select: {
      id: true,
      startDate: true,
      endDate: true,
      payDate: true,
      payScheduleId: true,
      paySchedule: { select: { name: true } },
    },
  })
  if (!period) return null
  const dueDate = timesheetDueDate(period.endDate, org.timesheetDueDaysAfterPeriodEnd)

  const sheets = await db.timesheet.findMany({
    where: { payPeriodId },
    select: { id: true, employeeId: true, status: true },
  })
  const expected = await db.employee.findMany({
    where: {
      employmentType: 'HOURLY',
      isActive: true,
      payScheduleId: period.payScheduleId,
      hireDate: { lte: period.endDate },
      OR: [{ terminationDate: null }, { terminationDate: { gte: period.startDate } }],
      id: { notIn: sheets.map((s) => s.employeeId) },
    },
    select: { id: true, firstName: true, lastName: true, email: true },
  })

  const submitted = await firstSubmissions(sheets.map((s) => s.id))
  const rows: PeriodRow[] = []
  for (const s of sheets) {
    const head = await sheetHead(s.id)
    if (!head) continue
    const grid = await gridFor(head)
    const firstSubmittedAt = submitted.get(s.id) ?? null
    rows.push({
      employee: head.employee,
      timesheetId: s.id,
      status: s.status,
      totals: grid.totals,
      timeliness: timeliness({ dueDate, firstSubmittedAt, now, timeZone: org.timezone }),
      firstSubmittedAt,
      grid,
    })
  }
  for (const e of expected) {
    rows.push({
      employee: e,
      timesheetId: null,
      status: null,
      totals: null,
      timeliness: null,
      firstSubmittedAt: null,
      grid: null,
    })
  }

  rows.sort(
    (a, b) =>
      a.employee.lastName.localeCompare(b.employee.lastName) ||
      a.employee.firstName.localeCompare(b.employee.firstName),
  )

  return { period, dueDate, rows }
}

/**
 * The payroll export: one row per employee. Figures are hours to two
 * decimals — what a payroll system imports — alongside the exact minutes,
 * which are what the system itself stores (rule 5). Leave is broken out by
 * type, a column each, for the types that appear in the period.
 */
export function periodCsvRows(
  period: { startDate: Date; endDate: Date },
  rows: readonly Pick<PeriodRow, 'employee' | 'status' | 'totals' | 'timeliness'>[],
): CsvCell[][] {
  const types = new Map<string, string>()
  for (const r of rows) {
    for (const t of r.totals?.leaveByType ?? []) types.set(t.leaveTypeId, t.leaveTypeName)
  }
  const typeColumns = [...types.entries()].sort((a, b) => a[1].localeCompare(b[1]))

  const hours = (minutes: number) => (minutes / 60).toFixed(2)
  const iso = (date: Date) => date.toISOString().slice(0, 10)
  const figures = ['Regular', 'Overtime', 'Holiday', ...typeColumns.map(([, name]) => name)]

  const header: CsvCell[] = [
    'Period start',
    'Period end',
    'Last name',
    'First name',
    'Email',
    'Status',
    'Submitted',
    ...figures.map((f) => `${f} hours`),
    ...figures.map((f) => `${f} minutes`),
  ]

  const body = rows.map((r) => {
    const t = r.totals
    const minutes = [
      t?.regular ?? 0,
      t?.overtime ?? 0,
      t?.holiday ?? 0,
      ...typeColumns.map(([id]) => t?.leaveByType.find((l) => l.leaveTypeId === id)?.minutes ?? 0),
    ]
    return [
      iso(period.startDate),
      iso(period.endDate),
      r.employee.lastName,
      r.employee.firstName,
      r.employee.email,
      r.status ?? 'NOT CREATED',
      r.timeliness ? TIMELINESS_CSV[r.timeliness] : '',
      ...minutes.map(hours),
      ...minutes,
    ]
  })

  return [header, ...body]
}

const TIMELINESS_CSV: Record<Timeliness, string> = {
  DUE: 'NOT YET',
  OVERDUE: 'OVERDUE',
  ON_TIME: 'ON TIME',
  LATE: 'LATE',
}

/**
 * One employee's timesheet for a period: a row per day with what was worked
 * and taken, then a TOTAL row. The figures are the same `buildGrid` ones the
 * timesheet page and the summary show. Days with nothing on them are kept, so
 * finance sees the whole period rather than having to infer the gaps.
 */
export function employeeCsvRows(
  sheet: {
    employee: Pick<SheetHead['employee'], 'firstName' | 'lastName' | 'email'>
    payPeriod: { startDate: Date; endDate: Date }
    status: SheetHead['status']
  },
  grid: Grid,
): CsvCell[][] {
  const iso = (date: Date) => date.toISOString().slice(0, 10)
  const hours = (minutes: number) => (minutes / 60).toFixed(2)
  const who = [
    sheet.employee.lastName,
    sheet.employee.firstName,
    sheet.employee.email,
    iso(sheet.payPeriod.startDate),
    iso(sheet.payPeriod.endDate),
    sheet.status,
  ]

  const header: CsvCell[] = [
    'Last name',
    'First name',
    'Email',
    'Period start',
    'Period end',
    'Status',
    'Date',
    'Day',
    'Worked hours',
    'Regular hours',
    'Overtime hours',
    'Holiday hours',
    'Leave hours',
    'Leave type',
    'Holiday',
    'Note',
    'Worked minutes',
    'Regular minutes',
    'Overtime minutes',
    'Holiday minutes',
    'Leave minutes',
  ]

  const line = (
    date: string,
    day: string,
    m: { worked: number; overtime: number; holiday: number; leave: number },
    text: { leaveType: string; holiday: string; note: string },
  ): CsvCell[] => {
    const regular = m.worked - m.overtime
    return [
      ...who,
      date,
      day,
      hours(m.worked),
      hours(regular),
      hours(m.overtime),
      hours(m.holiday),
      hours(m.leave),
      text.leaveType,
      text.holiday,
      text.note,
      m.worked,
      regular,
      m.overtime,
      m.holiday,
      m.leave,
    ]
  }

  const days = grid.days.map((d) =>
    line(
      d.iso,
      d.date.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
      {
        worked: d.worked,
        overtime: d.overtime,
        holiday: d.holiday?.minutes ?? 0,
        leave: d.leave.reduce((sum, l) => sum + l.minutes, 0),
      },
      {
        leaveType: [...new Set(d.leave.map((l) => l.leaveTypeName))].join('; '),
        holiday: d.holiday?.name ?? '',
        note: d.note ?? '',
      },
    ),
  )

  const t = grid.totals
  const total = line(
    'TOTAL',
    '',
    { worked: t.worked, overtime: t.overtime, holiday: t.holiday, leave: t.leave },
    {
      leaveType: t.leaveByType.map((l) => `${l.leaveTypeName} ${hours(l.minutes)}`).join('; '),
      holiday: '',
      note: '',
    },
  )

  return [header, ...days, total]
}

/** `timesheet-2026-10-04-okafor-sam.csv` — plain ASCII, safe in any zip tool. */
export function employeeCsvName(
  employee: { firstName: string; lastName: string },
  periodStart: Date,
): string {
  const slug = (value: string) =>
    value
      .normalize('NFKD')
      .replace(/[^\x00-\x7f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'employee'
  return `timesheet-${periodStart.toISOString().slice(0, 10)}-${slug(employee.lastName)}-${slug(employee.firstName)}.csv`
}
