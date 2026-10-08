import { describe, expect, it } from 'vitest'

import {
  addDays,
  benefitYearContaining,
  benefitYearStartingIn,
  daysInMonth,
  inclusiveDays,
  isWithinMonthDayWindow,
  resolveMonthDay,
  todayIn,
} from '@/lib/accrual/dates'

import { d, iso } from './support/accrual'

describe('resolveMonthDay', () => {
  it('takes a day inside the month literally', () => {
    expect(iso(resolveMonthDay(2026, 6, 15))).toBe('2026-06-15')
    expect(iso(resolveMonthDay(2026, 1, 1))).toBe('2026-01-01')
  })

  it('clamps a day past the end of the month to the last day', () => {
    expect(iso(resolveMonthDay(2026, 4, 31))).toBe('2026-04-30')
    expect(iso(resolveMonthDay(2026, 9, 31))).toBe('2026-09-30')
  })

  /**
   * The example configuration's comp window ends on February 28, meaning "the
   * end of February" (docs/CONFIGURATION.md). Resolving it literally would
   * expire carried comp a day early every fourth year.
   */
  it('resolves a February 28 window to February 29 in a leap year', () => {
    expect(iso(resolveMonthDay(2028, 2, 28))).toBe('2028-02-29')
    expect(iso(resolveMonthDay(2027, 2, 28))).toBe('2027-02-28')
  })

  it('resolves a configured February 29 in a common year too', () => {
    expect(iso(resolveMonthDay(2027, 2, 29))).toBe('2027-02-28')
    expect(iso(resolveMonthDay(2028, 2, 29))).toBe('2028-02-29')
  })

  it('leaves a day below the month floor alone', () => {
    expect(iso(resolveMonthDay(2028, 2, 27))).toBe('2028-02-27')
  })

  it('rejects a month or day that is not a calendar position', () => {
    expect(() => resolveMonthDay(2026, 0, 1)).toThrow()
    expect(() => resolveMonthDay(2026, 13, 1)).toThrow()
    expect(() => resolveMonthDay(2026, 1, 0)).toThrow()
    expect(() => resolveMonthDay(2026, 1, 32)).toThrow()
  })
})

describe('daysInMonth', () => {
  it('follows the calendar, leap years included', () => {
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2028, 2)).toBe(29)
    expect(daysInMonth(2026, 4)).toBe(30)
    expect(daysInMonth(2026, 12)).toBe(31)
    expect(daysInMonth(2100, 2)).toBe(28)
    expect(daysInMonth(2000, 2)).toBe(29)
  })
})

describe('benefit years', () => {
  it('runs January to December for a calendar year', () => {
    const year = benefitYearStartingIn(2026, 1, 1)
    expect([iso(year.start), iso(year.end), year.label]).toEqual(['2026-01-01', '2026-12-31', 2026])
  })

  /** The roadmap's "a benefit year that isn't the calendar year" case. */
  it('runs July to June for a July 1 start, labelled by the year it opens', () => {
    const year = benefitYearStartingIn(2026, 7, 1)
    expect([iso(year.start), iso(year.end), year.label]).toEqual(['2026-07-01', '2027-06-30', 2026])
  })

  it('places a date in the year that contains it', () => {
    expect(iso(benefitYearContaining(d('2026-05-03'), 1, 1).start)).toBe('2026-01-01')
    expect(iso(benefitYearContaining(d('2026-05-03'), 7, 1).start)).toBe('2025-07-01')
    expect(iso(benefitYearContaining(d('2026-07-01'), 7, 1).start)).toBe('2026-07-01')
    expect(iso(benefitYearContaining(d('2026-06-30'), 7, 1).start)).toBe('2025-07-01')
  })

  it('leaves no gap and no overlap between consecutive years', () => {
    for (const [month, day] of [
      [1, 1],
      [7, 1],
      [2, 28],
      [12, 31],
    ]) {
      for (let year = 2024; year <= 2030; year += 1) {
        const current = benefitYearStartingIn(year, month, day)
        const next = benefitYearStartingIn(year + 1, month, day)
        expect(iso(addDays(current.end, 1))).toBe(iso(next.start))
        expect(inclusiveDays(current.start, current.end)).toBeGreaterThanOrEqual(365)
      }
    }
  })
})

describe('isWithinMonthDayWindow', () => {
  it('includes both ends of a December window', () => {
    const inWindow = (date: string) => isWithinMonthDayWindow(d(date), 12, 1, 12, 31)
    expect(inWindow('2026-12-01')).toBe(true)
    expect(inWindow('2026-12-31')).toBe(true)
    expect(inWindow('2026-11-30')).toBe(false)
    expect(inWindow('2027-01-01')).toBe(false)
  })

  it('includes February 29 in a window ending February 28', () => {
    expect(isWithinMonthDayWindow(d('2028-02-29'), 2, 1, 2, 28)).toBe(true)
    expect(isWithinMonthDayWindow(d('2028-03-01'), 2, 1, 2, 28)).toBe(false)
  })

  it('wraps across the new year when the end precedes the start', () => {
    const inWindow = (date: string) => isWithinMonthDayWindow(d(date), 11, 15, 1, 15)
    expect(inWindow('2026-11-20')).toBe(true)
    expect(inWindow('2026-12-31')).toBe(true)
    expect(inWindow('2026-01-10')).toBe(true)
    expect(inWindow('2026-06-01')).toBe(false)
  })
})

describe('todayIn', () => {
  it('is the org’s calendar day, not the server’s', () => {
    // 9pm in New York on 7 October is already 8 October in UTC.
    const now = new Date('2026-10-08T01:00:00.000Z')
    expect(todayIn('America/New_York', now).toISOString()).toBe('2026-10-07T00:00:00.000Z')
    expect(todayIn('UTC', now).toISOString()).toBe('2026-10-08T00:00:00.000Z')
  })
})
