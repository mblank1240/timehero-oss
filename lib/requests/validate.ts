/**
 * The per-day rules a leave request has to satisfy, beyond its shape.
 *
 * The Zod schema (`./schema.ts`) checks what it can without the database: that
 * each day is a positive multiple of the increment, or a single sub-increment
 * day the stranded-balance exception might cover. This is the service-layer
 * half (rule 6 asks for both) — the checks that need the employee's balance,
 * the holiday calendar and the leave already booked.
 *
 * Pure. Sufficiency of the balance across the whole request is a separate,
 * later check (`firstShortfall`), because it needs the projected ledger.
 */

import { isValidIncrement, validateRequestedMinutes } from '@/lib/duration'

export type DayInput = { date: string; minutes: number }

export type DayRulesInput = {
  days: readonly DayInput[]
  incrementMinutes: number
  allowSubIncrementWhenBalanceIsLower: boolean
  /** The employee's `standardMinutesPerDay`. */
  minutesPerDay: number
  /** ISO date → holiday name. */
  holidays: ReadonlyMap<string, string>
  /** ISO date → minutes already on other pending or approved requests. */
  bookedMinutes: ReadonlyMap<string, number>
  /**
   * The balance available on the first requested day, before this request —
   * projected, and net of other pending requests. Read only by the
   * stranded-balance exception.
   */
  availableMinutes: number
  /** Renders a duration for a message. Defaults to plain minutes. */
  describe?: (minutes: number) => string
}

/** Field errors keyed by `day.<ISO date>`, plus `days` for the request as a whole. */
export type DayErrors = Record<string, string[]>

/**
 * Every rule a day can break, as field errors. Empty means valid.
 *
 * **The stranded-balance exception.** A day that is not a multiple of the
 * increment passes only when it is the request's only day, equals the whole
 * available balance, and that balance is below one increment — the rule is
 * `validateRequestedMinutes`, used here rather than restated. With more than
 * one day the exception cannot apply: it exists to spend a remainder, and a
 * remainder is one sub-increment amount, not several.
 *
 * **One working day at most per date**, counting leave already booked on it.
 * Half a day of PTO and half a day of sick on the same date is fine; two full
 * days is a mistake. The ceiling is the larger of the employee's day and one
 * increment, so a part-timer whose day is shorter than the increment can still
 * request the single option the form offers them.
 */
export function checkDays(input: DayRulesInput): DayErrors {
  const errors: DayErrors = {}
  const push = (key: string, message: string) => {
    ;(errors[key] ??= []).push(message)
  }

  const describe = input.describe ?? ((m: number) => `${m} minutes`)
  const single = input.days.length === 1
  const ceiling = Math.max(input.minutesPerDay, input.incrementMinutes)

  // `exceeds-balance` is deliberately not an error here. Whether the time is
  // there is the projection's question, and it can answer it for a type that
  // allows a negative balance, which this cannot.
  const isMalformed = (minutes: number) => {
    if (!single) return !isValidIncrement(minutes, input.incrementMinutes)
    const result = validateRequestedMinutes({
      minutes,
      incrementMinutes: input.incrementMinutes,
      remainingBalanceMinutes: input.availableMinutes,
      allowSubIncrementWhenBalanceIsLower: input.allowSubIncrementWhenBalanceIsLower,
    })
    return !result.ok && result.reason !== 'exceeds-balance'
  }

  for (const day of input.days) {
    const key = `day.${day.date}`

    const holiday = input.holidays.get(day.date)
    if (holiday) push(key, `${day.date} is a holiday (${holiday}), so it needs no leave.`)

    if (isMalformed(day.minutes)) {
      push(key, `Each day must be a multiple of ${describe(input.incrementMinutes)}.`)
    }

    const booked = input.bookedMinutes.get(day.date) ?? 0
    if (booked + day.minutes > ceiling) {
      push(
        key,
        booked > 0
          ? `${day.date} already has ${describe(booked)} of leave booked; this would exceed a working day.`
          : `${day.date} is more than one working day.`,
      )
    }
  }

  return errors
}
