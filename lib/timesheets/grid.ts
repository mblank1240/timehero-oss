/**
 * A timesheet laid out as days and workweeks, with its totals.
 *
 * Pure. The same function draws the page, freezes leave and holidays into
 * entries at submission, and sums the export — so what an employee sees, what
 * an approver approves and what payroll receives cannot disagree.
 *
 * Leave and holidays come in two forms. While a timesheet is open they are
 * read live from approved requests and the holiday calendar, so leave approved
 * mid-period appears without anyone touching the timesheet. From submission
 * on they are the frozen `LEAVE` and `HOLIDAY` entries, which is what was
 * approved. The caller decides which to pass; this does not care.
 */

import { fromUtcDay, toUtcDay } from '@/lib/accrual/dates'

import {
  dailyOvertime,
  weeksInRange,
  workweekStart,
  type OvertimeRules,
  type WorkedDay,
} from './overtime'

export type LeaveLine = {
  date: Date
  minutes: number
  leaveRequestId: string
  leaveTypeId: string
  leaveTypeName: string
}

export type HolidayLine = { date: Date; minutes: number; name: string }

export type WorkedLine = { date: Date; minutes: number; note: string | null }

export type GridInput = {
  period: { startDate: Date; endDate: Date }
  employee: { hireDate: Date; terminationDate: Date | null; standardMinutesPerDay: number }
  /** The employee's worked rows within the period. */
  worked: readonly WorkedLine[]
  /**
   * Worked rows from the days of the first workweek that fall before the
   * period — on the previous timesheet. They count toward that week's
   * overtime but are not this timesheet's.
   */
  workedBefore: readonly WorkedDay[]
  leave: readonly LeaveLine[]
  holidays: readonly HolidayLine[]
  rules: OvertimeRules
}

export type GridDay = {
  date: Date
  iso: string
  /** False before the hire date or after termination: nothing can be entered. */
  employed: boolean
  worked: number
  note: string | null
  overtime: number
  leave: LeaveLine[]
  holiday: HolidayLine | null
}

export type GridTotals = {
  worked: number
  overtime: number
  /** Worked less overtime: the hours paid at the ordinary rate. */
  regular: number
  holiday: number
  leave: number
  leaveByType: { leaveTypeId: string; leaveTypeName: string; minutes: number }[]
}

export type Grid = {
  days: GridDay[]
  weeks: ReturnType<typeof weeksInRange>
  totals: GridTotals
}

const iso = (date: Date) => date.toISOString().slice(0, 10)

/** Every date in the period, first to last. */
export function periodDates(period: { startDate: Date; endDate: Date }): Date[] {
  const dates: Date[] = []
  for (let day = toUtcDay(period.startDate); day <= toUtcDay(period.endDate); day += 1) {
    dates.push(fromUtcDay(day))
  }
  return dates
}

export function isEmployedOn(
  employee: { hireDate: Date; terminationDate: Date | null },
  date: Date,
): boolean {
  const day = toUtcDay(date)
  if (day < toUtcDay(employee.hireDate)) return false
  if (employee.terminationDate && day > toUtcDay(employee.terminationDate)) return false
  return true
}

/**
 * The paid holiday for an employee on one day: the calendar's hours, but no
 * more than the employee's own working day. A holiday is a day off with pay,
 * so a part-timer is paid the day they would have worked, not a full-timer's.
 * See docs/DECISIONS.md.
 */
export function holidayMinutesFor(holidayMinutes: number, standardMinutesPerDay: number): number {
  return Math.max(0, Math.min(holidayMinutes, standardMinutesPerDay))
}

/**
 * The live leave and holiday lines for a period, as they would be frozen if
 * the timesheet were submitted now. Only days the person was employed; a
 * holiday worth nothing to them is left out rather than written as zero.
 */
export function liveLines(args: {
  period: { startDate: Date; endDate: Date }
  employee: GridInput['employee']
  approvedLeave: readonly LeaveLine[]
  holidays: readonly HolidayLine[]
}): { leave: LeaveLine[]; holidays: HolidayLine[] } {
  const from = toUtcDay(args.period.startDate)
  const to = toUtcDay(args.period.endDate)
  const inPeriod = (date: Date) => toUtcDay(date) >= from && toUtcDay(date) <= to
  const counts = (date: Date) => inPeriod(date) && isEmployedOn(args.employee, date)

  return {
    leave: args.approvedLeave.filter((l) => counts(l.date) && l.minutes > 0),
    holidays: args.holidays
      .filter((h) => counts(h.date))
      .map((h) => ({
        ...h,
        minutes: holidayMinutesFor(h.minutes, args.employee.standardMinutesPerDay),
      }))
      .filter((h) => h.minutes > 0),
  }
}

export function buildGrid(input: GridInput): Grid {
  const dates = periodDates(input.period)
  const byDay = <T extends { date: Date }>(rows: readonly T[]) => {
    const map = new Map<number, T[]>()
    for (const row of rows) {
      const key = toUtcDay(row.date)
      map.set(key, [...(map.get(key) ?? []), row])
    }
    return map
  }

  const worked = byDay(input.worked)
  const leave = byDay(input.leave)
  const holidays = byDay(input.holidays)

  // Only the first workweek's days before the period count; anything older
  // belongs to a week this timesheet has no part in.
  const reach = toUtcDay(workweekStart(input.period.startDate, input.rules.weekStartDay))
  const start = toUtcDay(input.period.startDate)
  const before = input.workedBefore.filter(
    (d) => toUtcDay(d.date) >= reach && toUtcDay(d.date) < start,
  )
  const overtime = dailyOvertime(
    [...before, ...input.worked.map((w) => ({ date: w.date, minutes: w.minutes }))],
    input.rules,
  )
  const overtimeByDay = new Map(overtime.map((d) => [toUtcDay(d.date), d.overtime]))

  const days: GridDay[] = dates.map((date) => {
    const key = toUtcDay(date)
    const rows = worked.get(key) ?? []
    return {
      date,
      iso: iso(date),
      employed: isEmployedOn(input.employee, date),
      worked: rows.reduce((sum, r) => sum + r.minutes, 0),
      note: rows.find((r) => r.note)?.note ?? null,
      overtime: overtimeByDay.get(key) ?? 0,
      leave: leave.get(key) ?? [],
      holiday: holidays.get(key)?.[0] ?? null,
    }
  })

  const byType = new Map<string, GridTotals['leaveByType'][number]>()
  for (const l of input.leave) {
    const current = byType.get(l.leaveTypeId)
    if (current) current.minutes += l.minutes
    else {
      byType.set(l.leaveTypeId, {
        leaveTypeId: l.leaveTypeId,
        leaveTypeName: l.leaveTypeName,
        minutes: l.minutes,
      })
    }
  }

  const totalWorked = days.reduce((sum, d) => sum + d.worked, 0)
  const totalOvertime = days.reduce((sum, d) => sum + d.overtime, 0)

  return {
    days,
    weeks: weeksInRange(
      overtime,
      { from: input.period.startDate, to: input.period.endDate },
      input.rules.weekStartDay,
    ),
    totals: {
      worked: totalWorked,
      overtime: totalOvertime,
      regular: totalWorked - totalOvertime,
      holiday: days.reduce((sum, d) => sum + (d.holiday?.minutes ?? 0), 0),
      leave: input.leave.reduce((sum, l) => sum + l.minutes, 0),
      leaveByType: [...byType.values()].sort((a, b) =>
        a.leaveTypeName.localeCompare(b.leaveTypeName),
      ),
    },
  }
}
