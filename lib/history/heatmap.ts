/**
 * The history heatmap: a GitHub-contribution-style grid of the days an
 * employee took leave, one benefit year per grid.
 *
 * Columns are weeks and rows are weekdays, Sunday at the top. The first column
 * starts on the Sunday on or before the year's first day, so the grid can
 * begin with a few padding cells that belong to the previous year — those are
 * null, not empty days.
 *
 * Pure. Dates are DATE values (UTC midnight, rule 7) and are only ever read
 * through their UTC components.
 */

import { addDays, toUtcDay } from '@/lib/accrual/dates'

export type HeatmapUse = { leaveTypeId: string; minutes: number }

export type HeatmapCell = {
  date: Date
  iso: string
  /** Leave taken that day, one entry per type, largest first. */
  uses: HeatmapUse[]
  /** Total across every type. */
  minutes: number
}

/** Seven slots, Sunday first. Null where the slot falls outside the year. */
export type HeatmapWeek = (HeatmapCell | null)[]

export type Heatmap = {
  weeks: HeatmapWeek[]
  /** Where each month's label goes: the column holding its first day. */
  months: { week: number; month: number }[]
}

const DAYS_PER_WEEK = 7

export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * Collapses leave days into the per-date uses the grid renders. Two requests
 * of the same type on one date — two half days — are one use of a full day.
 */
export function groupUses(
  days: readonly { date: Date; minutes: number; leaveTypeId: string }[],
): Map<string, HeatmapUse[]> {
  const byDate = new Map<string, Map<string, number>>()
  for (const day of days) {
    const key = isoDay(day.date)
    const types = byDate.get(key) ?? new Map<string, number>()
    types.set(day.leaveTypeId, (types.get(day.leaveTypeId) ?? 0) + day.minutes)
    byDate.set(key, types)
  }

  return new Map(
    [...byDate].map(([key, types]) => [
      key,
      [...types]
        .map(([leaveTypeId, minutes]) => ({ leaveTypeId, minutes }))
        .sort((a, b) => b.minutes - a.minutes),
    ]),
  )
}

export function buildHeatmap(
  range: { start: Date; end: Date },
  uses: ReadonlyMap<string, readonly HeatmapUse[]>,
): Heatmap {
  const first = toUtcDay(range.start, 'start')
  const last = toUtcDay(range.end, 'end')
  if (last < first) throw new Error('end must not be before start')

  const gridStart = first - range.start.getUTCDay()
  const weeks: HeatmapWeek[] = []
  const months: Heatmap['months'] = []

  for (let day = first; day <= last; day++) {
    const date = addDays(range.start, day - first)
    const week = Math.floor((day - gridStart) / DAYS_PER_WEEK)
    weeks[week] ??= Array.from({ length: DAYS_PER_WEEK }, () => null)

    const iso = isoDay(date)
    const dayUses = [...(uses.get(iso) ?? [])]
    weeks[week][date.getUTCDay()] = {
      date,
      iso,
      uses: dayUses,
      minutes: dayUses.reduce((sum, u) => sum + u.minutes, 0),
    }

    // A year that starts mid-month still labels its first month, unless the
    // next month begins in that same column — then the column is the new
    // month's, since only one label fits above it.
    if (date.getUTCDate() === 1 || day === first) {
      const label = { week, month: date.getUTCMonth() + 1 }
      if (months.at(-1)?.week === week) months[months.length - 1] = label
      else months.push(label)
    }
  }

  return { weeks, months }
}

/**
 * How strongly to shade a day, 0 to 1: the share of the employee's own
 * working day taken. A half day reads lighter than a full one, and anything
 * at or past a full day is fully shaded.
 */
export function intensity(minutes: number, minutesPerDay: number): number {
  if (minutes <= 0 || minutesPerDay <= 0) return 0
  return Math.min(1, minutes / minutesPerDay)
}
