import { describe, expect, it } from 'vitest'

import { dailyOvertime, isoWeekday, weeksInRange, workweekStart } from '@/lib/timesheets/overtime'

import { d, iso } from './support/accrual'

// 4 October 2026 is a Sunday.
const SUNDAY = 7
const MONDAY = 1
const RULES = { thresholdMinutes: 2400, weekStartDay: SUNDAY }

const week = (start: string, minutes: number[]) =>
  minutes.map((m, i) => ({ date: new Date(d(start).getTime() + i * 86_400_000), minutes: m }))

describe('workweekStart', () => {
  it('finds the first day of the workweek for every start day', () => {
    expect(isoWeekday(d('2026-10-04'))).toBe(7)
    expect(isoWeekday(d('2026-10-05'))).toBe(1)
    expect(iso(workweekStart(d('2026-10-07'), SUNDAY))).toBe('2026-10-04')
    expect(iso(workweekStart(d('2026-10-04'), SUNDAY))).toBe('2026-10-04')
    expect(iso(workweekStart(d('2026-10-04'), MONDAY))).toBe('2026-09-28')
    expect(iso(workweekStart(d('2026-10-10'), 6))).toBe('2026-10-10')
  })

  it('refuses a weekday that is not 1-7', () => {
    expect(() => workweekStart(d('2026-10-07'), 0)).toThrow(RangeError)
    expect(() => workweekStart(d('2026-10-07'), 8)).toThrow(RangeError)
  })
})

describe('dailyOvertime', () => {
  it('finds no overtime in a 40-hour week', () => {
    const days = dailyOvertime(week('2026-10-05', [480, 480, 480, 480, 480]), RULES)
    expect(days.map((x) => x.overtime)).toEqual([0, 0, 0, 0, 0])
  })

  it('puts overtime on the day the threshold is crossed and every day after', () => {
    // 9h Mon-Thu = 36h, so Friday crosses 40 four hours in: its last 5h are overtime.
    const days = dailyOvertime(week('2026-10-05', [540, 540, 540, 540, 540, 120]), RULES)
    expect(days.map((x) => x.overtime)).toEqual([0, 0, 0, 0, 300, 120])
    expect(days.reduce((s, x) => s + x.overtime, 0)).toBe(540 * 5 + 120 - 2400)
  })

  it('counts each workweek separately', () => {
    const days = dailyOvertime(
      [...week('2026-10-04', [0, 600, 600, 600, 600, 0, 0]), ...week('2026-10-11', [0, 480])],
      RULES,
    )
    // 600 × 4 is exactly the threshold, and the next week starts again at zero.
    expect(days.every((x) => x.overtime === 0)).toBe(true)
    expect(iso(days.at(-1)!.weekStart)).toBe('2026-10-11')
  })

  it('moves the week boundary with the workweek start day', () => {
    // Sat 10h + Sun-Thu 8h each. Sunday weeks: Saturday closes the earlier
    // week; Saturday weeks: it opens this one, and Wednesday crosses 40.
    const days = week('2026-10-10', [600, 480, 480, 480, 480, 480])
    expect(dailyOvertime(days, RULES).reduce((s, x) => s + x.overtime, 0)).toBe(0)
    const saturday = dailyOvertime(days, { ...RULES, weekStartDay: 6 })
    expect(saturday.map((x) => x.overtime)).toEqual([0, 0, 0, 0, 120, 480])
  })

  it('treats a zero threshold as every minute overtime', () => {
    const days = dailyOvertime(week('2026-10-05', [60, 30]), { ...RULES, thresholdMinutes: 0 })
    expect(days.map((x) => x.overtime)).toEqual([60, 30])
  })

  it('adds duplicate dates together and ignores the order given', () => {
    const days = dailyOvertime(
      [
        { date: d('2026-10-09'), minutes: 600 },
        { date: d('2026-10-05'), minutes: 1200 },
        { date: d('2026-10-05'), minutes: 600 },
      ],
      RULES,
    )
    expect(days.map((x) => [iso(x.date), x.worked, x.overtime])).toEqual([
      ['2026-10-05', 1800, 0],
      ['2026-10-09', 600, 0],
    ])
  })

  it('refuses negative or fractional minutes', () => {
    expect(() => dailyOvertime([{ date: d('2026-10-05'), minutes: -1 }], RULES)).toThrow()
    expect(() => dailyOvertime([{ date: d('2026-10-05'), minutes: 1.5 }], RULES)).toThrow()
  })
})

describe('weeksInRange', () => {
  it('splits a straddling week, keeping only the overtime inside the range', () => {
    // Period Wed 7 – Tue 20 Oct. The first week began Sunday 4 Oct.
    const days = dailyOvertime(
      [...week('2026-10-05', [600, 600, 600, 600, 600])], // Mon-Fri, 50h
      RULES,
    )
    const weeks = weeksInRange(days, { from: d('2026-10-07'), to: d('2026-10-20') }, SUNDAY)
    expect(weeks.map((w) => [iso(w.start), iso(w.end), w.worked, w.overtime, w.weekWorked])).toEqual([
      ['2026-10-04', '2026-10-10', 1800, 600, 3000],
      ['2026-10-11', '2026-10-17', 0, 0, 0],
      ['2026-10-18', '2026-10-24', 0, 0, 0],
    ])
  })
})
