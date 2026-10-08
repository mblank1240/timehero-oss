/**
 * Duration formatting, parsing, and increment validation.
 *
 * Every duration in TimeHero is a signed integer count of minutes (CLAUDE.md
 * rule 5). Hours and days exist only here, in the display layer. Nothing in
 * this module may compute on a formatted value, and nothing outside it may
 * invent its own rendering — otherwise two screens disagree about what an
 * employee has.
 *
 * Pure: no database, no React, no org-specific literals. Every policy number
 * (the increment, the length of a working day) arrives as an argument.
 */

/** Mirrors `OrgSettings.displayUnit`. Affects rendering only, never storage. */
export type DisplayUnit = 'HOURS' | 'DAYS'

export type FormatDurationOptions = {
  unit: DisplayUnit
  /** The employee's `standardMinutesPerDay` — "a day" means nothing without it. */
  minutesPerDay: number
}

export type ParseDurationOptions = {
  minutesPerDay: number
}

export type IncrementOption = {
  minutes: number
  label: string
}

export type RequestedMinutesInput = {
  minutes: number
  incrementMinutes: number
  /** The employee's remaining balance for this leave type, in minutes. */
  remainingBalanceMinutes: number
  /** `OrgSettings.allowSubIncrementWhenBalanceIsLower`. */
  allowSubIncrementWhenBalanceIsLower: boolean
}

export type RequestedMinutesFailure = 'not-positive' | 'not-a-multiple' | 'exceeds-balance'

export type RequestedMinutesResult =
  | { ok: true }
  | { ok: false; reason: RequestedMinutesFailure }

const MINUTES_PER_HOUR = 60

/** A day is rendered in quarters, so this is the finest DAYS-mode granularity. */
const DAY_FRACTION_DENOMINATOR = 4

function isPositiveInt(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/**
 * Formats signed minutes for a human.
 *
 * DAYS mode renders only values that land on a clean quarter of the given
 * working day (0, ¼, ½, ¾, 1, 1¼, …). Anything else falls back to the HOURS
 * rendering: a leave balance of 160 minutes on an 8-hour day is "2h 40m", not
 * "0.333 days". Quarters are the cutoff because a quarter-day is the smallest
 * slice anyone schedules around, and every repeating decimal starts below it —
 * a rounded "0.3 days" would be a lie about an employee's balance, and we would
 * rather change units than change the number.
 */
export function formatDuration(minutes: number, opts: FormatDurationOptions): string {
  // A render must never throw or print NaN on a page, so coerce defensively.
  // Storage is integer minutes; a fraction here means a caller bug upstream.
  // `|| 0` also folds away -0, which would otherwise print as "-0 days".
  const total = (Number.isFinite(minutes) ? Math.round(minutes) : 0) || 0

  if (opts.unit === 'DAYS') {
    const days = formatAsDays(total, opts.minutesPerDay)
    if (days !== null) return days
  }

  return formatAsHours(total)
}

function formatAsDays(minutes: number, minutesPerDay: number): string | null {
  if (!isPositiveInt(minutesPerDay)) return null

  // Tested with integer modulo rather than on the quotient, so the decision is
  // never at the mercy of a floating-point division.
  if ((minutes * DAY_FRACTION_DENOMINATOR) % minutesPerDay !== 0) return null

  const days = minutes / minutesPerDay
  // Two decimals is exactly enough for quarters; trim so we never show "1.50".
  const text = days.toFixed(2).replace(/\.?0+$/, '')

  return `${text} ${Math.abs(days) === 1 ? 'day' : 'days'}`
}

function formatAsHours(minutes: number): string {
  const sign = minutes < 0 ? '-' : ''
  const abs = Math.abs(minutes)
  const hours = Math.floor(abs / MINUTES_PER_HOUR)
  const rest = abs % MINUTES_PER_HOUR

  // "45m" rather than "0h 45m", but plain zero still reads as a duration.
  if (hours === 0 && rest !== 0) return `${sign}${rest}m`
  if (rest === 0) return `${sign}${hours}h`

  return `${sign}${hours}h ${rest}m`
}

const DAYS_INPUT = /^(\d+(?:\.\d+)?)\s*(?:d|days?)$/
const CLOCK_INPUT = /^(\d+):(\d{1,2})$/
const HOURS_INPUT = /^(\d+(?:\.\d+)?)\s*h(?:rs?|ours?)?\s*(?:(\d+(?:\.\d+)?)\s*(?:m(?:ins?|inutes?)?)?)?$/
const MINUTES_INPUT = /^(\d+(?:\.\d+)?)\s*m(?:ins?|inutes?)?$/
const BARE_INPUT = /^(\d+(?:\.\d+)?)$/

/**
 * Parses what someone typed into integer minutes, or null when it is not a
 * duration at all. Deliberately lenient about spelling and spacing — the
 * request form offers fixed choices, so free text only ever reaches here from
 * an admin adjusting a ledger entry, where rejecting "7h30m" over a missing
 * space would just be rude.
 *
 * A bare number means hours ("8" is a working day, not eight minutes), which is
 * how people say it out loud. Fractions round to the nearest minute so the
 * result is always a whole number of minutes, never a float and never NaN.
 */
export function parseDuration(input: string, opts: ParseDurationOptions): number | null {
  if (typeof input !== 'string') return null

  const trimmed = input.trim().toLowerCase()
  if (trimmed === '') return null

  const sign = trimmed.startsWith('-') ? -1 : 1
  const body = (/^[-+]/.test(trimmed) ? trimmed.slice(1) : trimmed).trim()
  if (body === '') return null

  const minutes = parseUnsigned(body, opts.minutesPerDay)
  if (minutes === null) return null

  // -0 is a real JavaScript value and compares oddly; normalize it away.
  return sign * minutes || 0
}

function parseUnsigned(body: string, minutesPerDay: number): number | null {
  const clock = CLOCK_INPUT.exec(body)
  if (clock) {
    const mins = Number(clock[2])
    // "7:75" is a typo, not 8h15m — refuse rather than guess.
    if (mins >= MINUTES_PER_HOUR) return null
    return toMinutes(Number(clock[1]) * MINUTES_PER_HOUR + mins)
  }

  const days = DAYS_INPUT.exec(body)
  if (days) {
    if (!isPositiveInt(minutesPerDay)) return null
    return toMinutes(Number(days[1]) * minutesPerDay)
  }

  const hours = HOURS_INPUT.exec(body)
  if (hours) {
    const extra = hours[2] === undefined ? 0 : Number(hours[2])
    return toMinutes(Number(hours[1]) * MINUTES_PER_HOUR + extra)
  }

  const mins = MINUTES_INPUT.exec(body)
  if (mins) return toMinutes(Number(mins[1]))

  const bare = BARE_INPUT.exec(body)
  if (bare) return toMinutes(Number(bare[1]) * MINUTES_PER_HOUR)

  return null
}

function toMinutes(value: number): number | null {
  if (!Number.isFinite(value)) return null
  const rounded = Math.round(value)
  // Beyond this a value is a mistyped year or an overflow, not a duration.
  if (!Number.isSafeInteger(rounded)) return null
  return rounded
}

/**
 * The base rule from DATA-MODEL.md: `minutes > 0 AND minutes % increment == 0`.
 * A zero or negative request is not an increment question, so it fails here
 * too. An increment that is not itself a positive whole number is misconfigured
 * and can validate nothing.
 */
export function isValidIncrement(minutes: number, incrementMinutes: number): boolean {
  if (!isPositiveInt(incrementMinutes)) return false
  if (!isPositiveInt(minutes)) return false

  return minutes % incrementMinutes === 0
}

/**
 * Validates one day's requested minutes against the increment and the balance.
 *
 * The stranded-balance exception (SPEC.md "Time units and increments"): at a
 * 240-minute increment an employee holding 180 minutes could never spend it,
 * so with `allowSubIncrementWhenBalanceIsLower` on, a request equal to the
 * entire remaining balance passes even when it is not a multiple. This is the
 * only path to a non-multiple usage entry.
 *
 * The exception requires BOTH that the request equals the whole remaining
 * balance AND that the balance is below one increment. Dropping the second
 * condition would let someone with 7200 minutes request all 7200 as a single
 * non-multiple entry, which defeats the increment rule entirely. Narrowing it
 * costs nothing: a 500-minute balance at a 240 increment is spent as 480 and
 * then 20, so nothing is ever stranded either way.
 *
 * The increment is checked before the balance, matching the order the spec
 * states the rules in, so a malformed amount is reported as malformed even
 * when the employee also lacks the time.
 */
export function validateRequestedMinutes(
  args: RequestedMinutesInput,
): RequestedMinutesResult {
  const { minutes, incrementMinutes, remainingBalanceMinutes } = args

  // NaN and fractions of a minute fail the positivity gate only when they are
  // not positive; a positive fraction is reported as the increment problem it
  // actually is.
  if (!(Number.isFinite(minutes) && minutes > 0)) {
    return { ok: false, reason: 'not-positive' }
  }

  // A zero or negative balance can never satisfy the exception: the request
  // itself must be positive, so it can never equal a balance that is not.
  const exception =
    args.allowSubIncrementWhenBalanceIsLower &&
    Number.isInteger(minutes) &&
    minutes === remainingBalanceMinutes &&
    remainingBalanceMinutes < incrementMinutes

  if (!isValidIncrement(minutes, incrementMinutes) && !exception) {
    return { ok: false, reason: 'not-a-multiple' }
  }

  if (minutes > remainingBalanceMinutes) return { ok: false, reason: 'exceeds-balance' }

  return { ok: true }
}

export type IncrementOptionsInput = {
  incrementMinutes: number
  minutesPerDay: number
  /** Upper bound for the list; defaults to one working day. */
  maxMinutes?: number
}

/**
 * The choices a request form offers for a single day. Returning the options
 * rather than a free-text box is what makes the increment rule invisible to
 * employees — every entry is a valid multiple by construction.
 *
 * Only multiples of the increment are ever offered, even when that means the
 * full working day is missing from the list: a 300-minute increment on an
 * 8-hour day can legally produce "5h" and nothing else, and offering a
 * tempting-but-invalid "Full day" would only fail validation later. When no
 * multiple fits inside the cap at all, the single smallest legal request is
 * offered anyway, so the form is never a dead end.
 */
export function incrementOptions(args: IncrementOptionsInput): IncrementOption[] {
  const { incrementMinutes, minutesPerDay } = args
  if (!isPositiveInt(incrementMinutes)) return []

  const cap = args.maxMinutes ?? minutesPerDay
  const limit = Number.isFinite(cap) ? Math.floor(cap) : 0

  const options: IncrementOption[] = []
  for (let minutes = incrementMinutes; minutes <= limit; minutes += incrementMinutes) {
    options.push({ minutes, label: optionLabel(minutes, minutesPerDay) })
  }

  if (options.length === 0) {
    options.push({
      minutes: incrementMinutes,
      label: optionLabel(incrementMinutes, minutesPerDay),
    })
  }

  return options
}

function optionLabel(minutes: number, minutesPerDay: number): string {
  // "Half day" and "Full day" are how staff talk about leave; the raw duration
  // is only useful for the sizes that have no name.
  if (isPositiveInt(minutesPerDay)) {
    if (minutes === minutesPerDay) return 'Full day'
    if (minutes * 2 === minutesPerDay) return 'Half day'
  }

  return formatDuration(minutes, { unit: 'HOURS', minutesPerDay })
}
