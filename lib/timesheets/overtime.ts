/**
 * Weekly overtime on an hourly timesheet.
 *
 * Pure: the service reads the worked days and hands them here. Overtime is
 * never entered by the employee — it is what the workweek says it is, so the
 * split between regular and overtime pay can never disagree with the hours.
 *
 * **What counts.** Only time worked. FLSA counts hours actually worked toward
 * the weekly threshold, so paid leave and paid holidays do not push anyone into
 * overtime; they are not passed in here at all.
 *
 * **Which day it lands on.** The threshold is crossed on a particular day, and
 * everything worked from that moment on is overtime. Each day's overtime is
 * the part of that day above the threshold, counting the week from its first
 * day. A workweek is fixed by the employer and need not line up with the pay
 * period, so a week can straddle two timesheets; because a day's overtime only
 * depends on the days before it, the earlier timesheet's figures never change
 * when the later one is filled in, and nothing has to be paid back and forth
 * between periods. docs/DECISIONS.md has the alternatives.
 *
 * The threshold and the first day of the workweek are org settings (rule 1).
 */

import { addDays, fromUtcDay, toUtcDay } from '@/lib/accrual/dates'

export type WorkedDay = { date: Date; minutes: number }

export type OvertimeRules = {
  /** Minutes worked in one workweek before overtime begins. */
  thresholdMinutes: number
  /** ISO weekday the workweek starts on, 1 = Monday … 7 = Sunday. */
  weekStartDay: number
}

export type DayOvertime = {
  date: Date
  worked: number
  /** The part of `worked` beyond the weekly threshold. */
  overtime: number
  /** The first day of the workweek this day belongs to. */
  weekStart: Date
}

export type WeekSummary = {
  start: Date
  /** Inclusive. */
  end: Date
  worked: number
  overtime: number
}

/** ISO weekday of a UTC date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: Date): number {
  return ((date.getUTCDay() + 6) % 7) + 1
}

/** The first day of the workweek containing `date`. */
export function workweekStart(date: Date, weekStartDay: number): Date {
  if (!Number.isInteger(weekStartDay) || weekStartDay < 1 || weekStartDay > 7) {
    throw new RangeError(`weekStartDay must be 1-7, got ${weekStartDay}`)
  }
  const back = (isoWeekday(date) - weekStartDay + 7) % 7
  return addDays(date, -back)
}

/**
 * Overtime for each worked day.
 *
 * `days` should cover every worked day of each workweek it touches, from the
 * week's first day — including days on another pay period's timesheet — or
 * the cumulative count starts late and overtime is understated. A day not
 * given is a day with nothing worked. Duplicate dates are added together.
 */
export function dailyOvertime(days: readonly WorkedDay[], rules: OvertimeRules): DayOvertime[] {
  if (!Number.isInteger(rules.thresholdMinutes) || rules.thresholdMinutes < 0) {
    throw new RangeError(`thresholdMinutes must be a non-negative integer`)
  }

  const byDay = new Map<number, number>()
  for (const d of days) {
    if (!Number.isInteger(d.minutes) || d.minutes < 0) {
      throw new RangeError(`worked minutes must be a non-negative integer`)
    }
    const key = toUtcDay(d.date)
    byDay.set(key, (byDay.get(key) ?? 0) + d.minutes)
  }

  const sorted = [...byDay.entries()].sort((a, b) => a[0] - b[0])
  const weekTotals = new Map<number, number>()
  const result: DayOvertime[] = []

  for (const [key, worked] of sorted) {
    const date = fromUtcDay(key)
    const weekStart = workweekStart(date, rules.weekStartDay)
    const weekKey = toUtcDay(weekStart)

    const before = weekTotals.get(weekKey) ?? 0
    const after = before + worked
    weekTotals.set(weekKey, after)

    const overtime =
      Math.max(0, after - rules.thresholdMinutes) - Math.max(0, before - rules.thresholdMinutes)

    result.push({ date, worked, overtime, weekStart })
  }

  return result
}

/**
 * The workweeks touching `from`…`to`, each with what was worked and the
 * overtime that fell inside the range. A week straddling the range's edge
 * reports only its days within it; `weekWorked` gives the whole week.
 */
export function weeksInRange(
  days: readonly DayOvertime[],
  range: { from: Date; to: Date },
  weekStartDay: number,
): (WeekSummary & { weekWorked: number })[] {
  const from = toUtcDay(range.from)
  const to = toUtcDay(range.to)
  const weeks: (WeekSummary & { weekWorked: number })[] = []

  for (
    let start = workweekStart(range.from, weekStartDay);
    toUtcDay(start) <= to;
    start = addDays(start, 7)
  ) {
    const startKey = toUtcDay(start)
    const end = addDays(start, 6)
    let worked = 0
    let overtime = 0
    let weekWorked = 0
    for (const d of days) {
      if (toUtcDay(d.weekStart) !== startKey) continue
      weekWorked += d.worked
      const key = toUtcDay(d.date)
      if (key < from || key > to) continue
      worked += d.worked
      overtime += d.overtime
    }
    weeks.push({ start, end, worked, overtime, weekWorked })
  }

  return weeks
}
