/**
 * Pay-period generation, as a pure module so the accrual engine and the
 * weekly `generate-pay-periods` job can be tested without a database. Nothing
 * here imports Prisma or `lib/env.ts`; a caller maps `GeneratedPeriod` onto
 * `PayPeriod` rows (`payScheduleId` + `startDate` is the unique key).
 *
 * Pay-period dates are DATE columns with no timezone (rule 7 in CLAUDE.md), so
 * every calculation below runs on whole UTC days and never on local-time
 * components. The output is therefore identical on a server in any timezone
 * and unaffected by DST transitions.
 */

export type PayScheduleType = 'WEEKLY' | 'BIWEEKLY' | 'SEMI_MONTHLY' | 'MONTHLY'

/** The parts of a `PaySchedule` row that the period maths actually needs. */
export type PayScheduleInput = {
  type: PayScheduleType
  /** The first period's start. See `firstPeriodStart` for how it is snapped. */
  anchorDate: Date
  /** Days after `endDate` that payment lands. */
  payDateOffsetDays: number
}

export type GeneratedPeriod = {
  startDate: Date
  /** Inclusive — the last day worked in the period, not the next period's start. */
  endDate: Date
  payDate: Date
}

const MS_PER_DAY = 86_400_000

const PERIODS_PER_YEAR: Record<PayScheduleType, number> = {
  WEEKLY: 52,
  BIWEEKLY: 26,
  SEMI_MONTHLY: 24,
  MONTHLY: 12,
}

/** Day count for the two fixed-length types; the others follow the calendar. */
const FIXED_LENGTH_DAYS: Partial<Record<PayScheduleType, number>> = {
  WEEKLY: 7,
  BIWEEKLY: 14,
}

/**
 * The divisor the accrual engine uses to turn an annual grant into a
 * per-period one. These are the nominal counts the policy is written against,
 * not the number of periods a particular calendar year happens to contain — a
 * biweekly year occasionally holds 27 periods, and paying 27/26 of the annual
 * grant in that year is deliberate, not a bug to round away.
 */
export function periodsPerYear(type: PayScheduleType): number {
  const n = PERIODS_PER_YEAR[type]
  if (n === undefined) throw new Error(`Unknown pay schedule type: ${String(type)}`)
  return n
}

/**
 * Every period that OVERLAPS `[from, through]` (both inclusive), in ascending
 * order. Overlap rather than containment is the right rule for the callers we
 * have: the generation job must not leave a hole at the edge of its window,
 * and a timesheet query for "this month" wants the period that straddles the
 * 1st. A caller that only wants whole periods can filter the ends off.
 *
 * Periods are contiguous: each `startDate` is the previous `endDate` plus one
 * day, with no gap and no overlap, across month, year and leap-day boundaries.
 */
export function generatePeriods(
  schedule: PayScheduleInput,
  args: { from: Date; through: Date },
): GeneratedPeriod[] {
  const { type } = assertValidSchedule(schedule)
  const fromDay = toUtcDay(args.from, 'from')
  const throughDay = toUtcDay(args.through, 'through')
  if (throughDay < fromDay) return []

  const anchorDay = firstPeriodStart(schedule)
  if (anchorDay > throughDay) return []

  // Start at the period containing `from`, or at the anchor when the schedule
  // begins mid-range — a schedule never produces periods before its anchor.
  let cursor = fromDay <= anchorDay ? anchorDay : startOfPeriodContaining(type, anchorDay, fromDay)

  // A well-formed schedule advances at least one day per step, so the span
  // itself bounds the loop. The guard is here so a schedule type that somehow
  // failed to advance fails loudly instead of hanging the generation job.
  const maxPeriods = throughDay - cursor + 2
  const periods: GeneratedPeriod[] = []

  while (cursor <= throughDay) {
    const endDay = endOfPeriod(type, cursor)
    periods.push({
      startDate: fromUtcDay(cursor),
      endDate: fromUtcDay(endDay),
      payDate: fromUtcDay(endDay + schedule.payDateOffsetDays),
    })

    const next = nextPeriodStart(type, cursor)
    if (next <= cursor) throw new Error(`Pay schedule did not advance past ${fromUtcDay(cursor).toISOString()}`)
    cursor = next

    if (periods.length > maxPeriods) throw new Error('Pay-period generation exceeded its bound')
  }

  return periods
}

/**
 * The period `date` falls in, or `null` when the date precedes the schedule's
 * first period. Computed directly rather than by scanning a generated list, so
 * it stays O(1) however far the date is from the anchor.
 */
export function periodContaining(schedule: PayScheduleInput, date: Date): GeneratedPeriod | null {
  const { type } = assertValidSchedule(schedule)
  const day = toUtcDay(date, 'date')

  const anchorDay = firstPeriodStart(schedule)
  if (day < anchorDay) return null

  const startDay = startOfPeriodContaining(type, anchorDay, day)
  const endDay = endOfPeriod(type, startDay)
  return {
    startDate: fromUtcDay(startDay),
    endDate: fromUtcDay(endDay),
    payDate: fromUtcDay(endDay + schedule.payDateOffsetDays),
  }
}

/**
 * The first period's start, as a UTC day number.
 *
 * WEEKLY and BIWEEKLY lay a grid off the anchor, so the anchor is the start.
 * SEMI_MONTHLY and MONTHLY follow the calendar instead, so an anchor that is
 * not already on the 1st or the 16th is snapped BACK to the start of the
 * calendar period containing it. Snapping back (rather than emitting a short
 * first period) keeps every period a full one: accrual divides an annual grant
 * by `periodsPerYear`, so a truncated period would quietly over-grant.
 */
function firstPeriodStart(schedule: PayScheduleInput): number {
  const anchorDay = toUtcDay(schedule.anchorDate, 'anchorDate')
  if (FIXED_LENGTH_DAYS[schedule.type]) return anchorDay
  return calendarPeriodStart(schedule.type, anchorDay)
}

function startOfPeriodContaining(type: PayScheduleType, anchorDay: number, day: number): number {
  const length = FIXED_LENGTH_DAYS[type]
  if (length) {
    // Floor division keeps the grid aligned for dates on either side of the
    // anchor; `day >= anchorDay` is guaranteed by both callers.
    return anchorDay + Math.floor((day - anchorDay) / length) * length
  }
  return calendarPeriodStart(type, day)
}

function calendarPeriodStart(type: PayScheduleType, day: number): number {
  const { year, month, dayOfMonth } = partsOf(day)
  if (type === 'MONTHLY') return toDay(year, month, 1)
  // SEMI_MONTHLY: the 1st-15th, then the 16th to the end of the month.
  return toDay(year, month, dayOfMonth <= 15 ? 1 : 16)
}

function endOfPeriod(type: PayScheduleType, startDay: number): number {
  const length = FIXED_LENGTH_DAYS[type]
  if (length) return startDay + length - 1

  const { year, month, dayOfMonth } = partsOf(startDay)
  if (type === 'SEMI_MONTHLY' && dayOfMonth === 1) return toDay(year, month, 15)
  // Day 0 of the next month is the last day of this one, which is how 28, 29,
  // 30 and 31-day months (and 29 February) are handled without a special case.
  return toDay(year, month + 1, 0)
}

function nextPeriodStart(type: PayScheduleType, startDay: number): number {
  const length = FIXED_LENGTH_DAYS[type]
  if (length) return startDay + length

  const { year, month, dayOfMonth } = partsOf(startDay)
  if (type === 'SEMI_MONTHLY' && dayOfMonth === 1) return toDay(year, month, 16)
  return toDay(year, month + 1, 1)
}

function assertValidSchedule(schedule: PayScheduleInput): PayScheduleInput {
  if (PERIODS_PER_YEAR[schedule.type] === undefined) {
    throw new Error(`Unknown pay schedule type: ${String(schedule.type)}`)
  }
  if (!Number.isInteger(schedule.payDateOffsetDays) || schedule.payDateOffsetDays < 0) {
    // A negative offset would pay before the period closes; it is a bad row,
    // not something to silently normalise.
    throw new Error(`payDateOffsetDays must be a non-negative integer, got ${String(schedule.payDateOffsetDays)}`)
  }
  return schedule
}

/**
 * Whole days since the epoch, read off the UTC components so a `Date` carrying
 * a stray time-of-day (or parsed in a non-UTC zone) still lands on its own day.
 */
function toUtcDay(d: Date, label: string): number {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
    throw new Error(`${label} must be a valid Date`)
  }
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / MS_PER_DAY
}

function fromUtcDay(day: number): Date {
  return new Date(day * MS_PER_DAY)
}

function toDay(year: number, month: number, dayOfMonth: number): number {
  // Date.UTC normalises an out-of-range month or day, which is what makes
  // `month + 1, 0` and `month + 1, 1` safe across a year boundary.
  return Date.UTC(year, month, dayOfMonth) / MS_PER_DAY
}

function partsOf(day: number): { year: number; month: number; dayOfMonth: number } {
  const d = fromUtcDay(day)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), dayOfMonth: d.getUTCDate() }
}
