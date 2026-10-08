/**
 * Calendar arithmetic for the accrual engine.
 *
 * Leave dates are DATE columns with no timezone (rule 7 in CLAUDE.md), so
 * every calculation here runs on whole UTC days and never reads a local-time
 * component. A grant computed on a laptop in New York and on a server in UTC
 * must land on the same day, and a DST transition must not move a benefit year.
 *
 * Pure: no database, no org-specific literals. Every month, day and day-count
 * arrives as an argument.
 */

export const MS_PER_DAY = 86_400_000

/** A benefit year, resolved to real dates. `label` is the year it starts in. */
export type BenefitYear = {
  /** The calendar year the benefit year begins in — `2026` for 2026-01-01. */
  label: number
  start: Date
  /** Inclusive: the last day of the year, not the next year's first. */
  end: Date
}

/**
 * Whole days since the epoch, read off the UTC components so a `Date` carrying
 * a stray time-of-day still lands on its own day.
 */
export function toUtcDay(date: Date, label = 'date'): number {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be a valid Date`)
  }
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / MS_PER_DAY
}

export function fromUtcDay(day: number): Date {
  return new Date(day * MS_PER_DAY)
}

/** Strips any time-of-day, returning the UTC midnight a DATE column holds. */
export function toDateOnly(date: Date, label = 'date'): Date {
  return fromUtcDay(toUtcDay(date, label))
}

export function addDays(date: Date, days: number): Date {
  return fromUtcDay(toUtcDay(date) + days)
}

/** Signed whole days from `from` to `to`; 0 when they are the same day. */
export function daysBetween(from: Date, to: Date): number {
  return toUtcDay(to) - toUtcDay(from)
}

/** Day count of a closed range, counting both ends. */
export function inclusiveDays(from: Date, to: Date): number {
  return daysBetween(from, to) + 1
}

export function isSameDay(a: Date, b: Date): boolean {
  return toUtcDay(a) === toUtcDay(b)
}

export function isOnOrBefore(a: Date, b: Date): boolean {
  return toUtcDay(a) <= toUtcDay(b)
}

export function isOnOrAfter(a: Date, b: Date): boolean {
  return toUtcDay(a) >= toUtcDay(b)
}

export function maxDate(a: Date, b: Date): Date {
  return toUtcDay(a) >= toUtcDay(b) ? toDateOnly(a) : toDateOnly(b)
}

/** Length of `month` (1-based) in `year`, leap years included. */
export function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one, which handles 28, 29,
  // 30 and 31 without a table.
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** The shortest `month` ever is — February's 28. */
const SHORTEST_MONTH_LENGTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/**
 * Resolves a configured month/day to a real date inside `year`.
 *
 * A configured day at or past the shortest that month can ever be means *the
 * end of the month*, so it follows the calendar rather than a literal number:
 * "31" in a 30-day month is the 30th, and a comp window configured as
 * February 28 resolves to February 29 in a leap year. That last case is the
 * one that matters — a policy written in a common year should not quietly
 * expire someone's carried time a day early every fourth year, and the church
 * means "the end of February" when it says February 28 (docs/CONFIGURATION.md).
 *
 * A day below that threshold is taken literally: the 15th is the 15th.
 */
export function resolveMonthDay(year: number, month: number, day: number): Date {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`month must be 1-12, got ${String(month)}`)
  }
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new Error(`day must be 1-31, got ${String(day)}`)
  }

  const last = daysInMonth(year, month)
  const resolved = day >= SHORTEST_MONTH_LENGTH[month - 1] ? last : day

  return new Date(Date.UTC(year, month - 1, resolved))
}

/**
 * The benefit year that begins in `year`. For the church's calendar year this
 * is January 1 to December 31; for a July 1 fiscal year it is 1 July `year` to
 * 30 June `year + 1`.
 */
export function benefitYearStartingIn(
  year: number,
  startMonth: number,
  startDay: number,
): BenefitYear {
  const start = resolveMonthDay(year, startMonth, startDay)
  // One day before the next year's start, so consecutive benefit years are
  // contiguous with no gap and no overlap however the start date is clamped.
  const end = addDays(resolveMonthDay(year + 1, startMonth, startDay), -1)

  return { label: year, start, end }
}

/** The benefit year containing `date`. */
export function benefitYearContaining(
  date: Date,
  startMonth: number,
  startDay: number,
): BenefitYear {
  const day = toUtcDay(date)
  const year = fromUtcDay(day).getUTCFullYear()

  const candidate = benefitYearStartingIn(year, startMonth, startDay)
  if (day >= toUtcDay(candidate.start)) return candidate

  // The date falls before this calendar year's start, so it belongs to the
  // benefit year that opened the year before.
  return benefitYearStartingIn(year - 1, startMonth, startDay)
}

/**
 * Whether `date` falls inside a month/day window, ignoring which year it is.
 *
 * Both ends are inclusive and are resolved against the date's own year, so a
 * February 28 bound still includes February 29 in a leap year. A window whose
 * end precedes its start wraps across the new year — "November 15 to
 * January 15" is a single window, not an empty one.
 */
export function isWithinMonthDayWindow(
  date: Date,
  fromMonth: number,
  fromDay: number,
  toMonth: number,
  toDay: number,
): boolean {
  const day = toUtcDay(date)
  const year = fromUtcDay(day).getUTCFullYear()

  const from = toUtcDay(resolveMonthDay(year, fromMonth, fromDay))
  const to = toUtcDay(resolveMonthDay(year, toMonth, toDay))

  if (from <= to) return day >= from && day <= to
  return day >= from || day <= to
}

/**
 * Today's date in `timeZone`, as a DATE column holds it.
 *
 * "Today" for a leave rule is the org's day, not the server's: an App Service
 * instance runs in UTC, so at 9pm in New York it is already tomorrow there,
 * and an employee cancelling tomorrow's leave at 9pm would be told it had
 * already started. This is the one function in the module that reads a clock
 * zone, and it reads it only to find out which calendar day it is.
 */
export function todayIn(timeZone: string, now: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)

  const part = (type: 'year' | 'month' | 'day') => Number(parts.find((p) => p.type === type)?.value)

  return new Date(Date.UTC(part('year'), part('month') - 1, part('day')))
}
