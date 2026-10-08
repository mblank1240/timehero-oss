import { describe, expect, it } from 'vitest'

import {
  formatDuration,
  incrementOptions,
  isValidIncrement,
  parseDuration,
  validateRequestedMinutes,
} from '@/lib/duration'

/** Full-time: an 8-hour day. */
const FULL = 480
/** Part-time: a 4-hour day, where a 240-minute increment means a whole day. */
const PART = 240

const hours = { unit: 'HOURS', minutesPerDay: FULL } as const
const days = { unit: 'DAYS', minutesPerDay: FULL } as const

describe('formatDuration — HOURS', () => {
  it('renders whole hours without a minutes part', () => {
    expect(formatDuration(480, hours)).toBe('8h')
    expect(formatDuration(240, hours)).toBe('4h')
    expect(formatDuration(60, hours)).toBe('1h')
    expect(formatDuration(1440, hours)).toBe('24h')
  })

  it('renders hours and minutes together', () => {
    expect(formatDuration(450, hours)).toBe('7h 30m')
    expect(formatDuration(277, hours)).toBe('4h 37m')
    expect(formatDuration(61, hours)).toBe('1h 1m')
  })

  it('drops the leading "0h" for a sub-hour duration', () => {
    expect(formatDuration(45, hours)).toBe('45m')
    expect(formatDuration(1, hours)).toBe('1m')
    expect(formatDuration(59, hours)).toBe('59m')
  })

  it('renders zero as "0h"', () => {
    expect(formatDuration(0, hours)).toBe('0h')
  })

  it('signs negative ledger entries', () => {
    expect(formatDuration(-240, hours)).toBe('-4h')
    expect(formatDuration(-450, hours)).toBe('-7h 30m')
    expect(formatDuration(-45, hours)).toBe('-45m')
    expect(formatDuration(-1, hours)).toBe('-1m')
  })

  it('never renders NaN or Infinity onto a page', () => {
    expect(formatDuration(Number.NaN, hours)).toBe('0h')
    expect(formatDuration(Number.POSITIVE_INFINITY, hours)).toBe('0h')
    expect(formatDuration(Number.NEGATIVE_INFINITY, hours)).toBe('0h')
  })

  it('rounds a stray fraction rather than printing one', () => {
    expect(formatDuration(90.4, hours)).toBe('1h 30m')
    expect(formatDuration(-0.2, hours)).toBe('0h')
  })
})

describe('formatDuration — DAYS', () => {
  it('renders clean day counts', () => {
    expect(formatDuration(480, days)).toBe('1 day')
    expect(formatDuration(960, days)).toBe('2 days')
    expect(formatDuration(4800, days)).toBe('10 days')
    expect(formatDuration(0, days)).toBe('0 days')
  })

  it('renders quarter days', () => {
    expect(formatDuration(120, days)).toBe('0.25 days')
    expect(formatDuration(240, days)).toBe('0.5 days')
    expect(formatDuration(360, days)).toBe('0.75 days')
    expect(formatDuration(600, days)).toBe('1.25 days')
    expect(formatDuration(1200, days)).toBe('2.5 days')
  })

  it('trims trailing zeros', () => {
    expect(formatDuration(720, days)).toBe('1.5 days')
    expect(formatDuration(720, days)).not.toBe('1.50 days')
    expect(formatDuration(4800, days)).not.toBe('10.00 days')
  })

  it('uses the singular only for exactly one day', () => {
    expect(formatDuration(480, days)).toBe('1 day')
    expect(formatDuration(-480, days)).toBe('-1 day')
    expect(formatDuration(960, days)).toBe('2 days')
    expect(formatDuration(240, days)).toBe('0.5 days')
  })

  it('signs negative ledger entries', () => {
    expect(formatDuration(-240, days)).toBe('-0.5 days')
    expect(formatDuration(-120, days)).toBe('-0.25 days')
    expect(formatDuration(-1200, days)).toBe('-2.5 days')
  })

  it('falls back to hours when the value is not a clean quarter day', () => {
    expect(formatDuration(160, days)).toBe('2h 40m')
    expect(formatDuration(277, days)).toBe('4h 37m')
    expect(formatDuration(60, days)).toBe('1h')
    expect(formatDuration(-100, days)).toBe('-1h 40m')
  })

  it('scales to a part-timer with a 240-minute day', () => {
    const part = { unit: 'DAYS', minutesPerDay: PART } as const
    expect(formatDuration(240, part)).toBe('1 day')
    expect(formatDuration(120, part)).toBe('0.5 days')
    expect(formatDuration(60, part)).toBe('0.25 days')
    expect(formatDuration(480, part)).toBe('2 days')
    // Half an hour is an eighth of this day, so it drops back to hours.
    expect(formatDuration(30, part)).toBe('30m')
  })

  it('handles a working day that quarters unevenly', () => {
    const odd = { unit: 'DAYS', minutesPerDay: 450 } as const
    expect(formatDuration(450, odd)).toBe('1 day')
    expect(formatDuration(225, odd)).toBe('0.5 days')
    // 450 / 4 is 112.5 minutes, which is not a storable quarter.
    expect(formatDuration(113, odd)).toBe('1h 53m')
  })

  it('falls back to hours when minutesPerDay is unusable', () => {
    expect(formatDuration(480, { unit: 'DAYS', minutesPerDay: 0 })).toBe('8h')
    expect(formatDuration(480, { unit: 'DAYS', minutesPerDay: -480 })).toBe('8h')
    expect(formatDuration(480, { unit: 'DAYS', minutesPerDay: Number.NaN })).toBe('8h')
    expect(formatDuration(480, { unit: 'DAYS', minutesPerDay: 0.5 })).toBe('8h')
  })

  it('never renders a negative zero', () => {
    expect(formatDuration(-0, days)).toBe('0 days')
    expect(formatDuration(-0.1, days)).toBe('0 days')
  })
})

describe('parseDuration', () => {
  const opts = { minutesPerDay: FULL }
  const parse = (input: string) => parseDuration(input, opts)

  it('accepts the documented forms', () => {
    expect(parse('8h')).toBe(480)
    expect(parse('8')).toBe(480)
    expect(parse('7h30m')).toBe(450)
    expect(parse('7:30')).toBe(450)
    expect(parse('90m')).toBe(90)
    expect(parse('1 day')).toBe(480)
    expect(parse('0.5 days')).toBe(240)
    expect(parse('1.5d')).toBe(720)
  })

  it('is lenient about case, spacing, and spelling', () => {
    expect(parse('8H')).toBe(480)
    expect(parse('  8h  ')).toBe(480)
    expect(parse('8 hours')).toBe(480)
    expect(parse('8 hour')).toBe(480)
    expect(parse('8 hrs')).toBe(480)
    expect(parse('7h 30m')).toBe(450)
    expect(parse('7h30')).toBe(450)
    expect(parse('45 mins')).toBe(45)
    expect(parse('45 minutes')).toBe(45)
    expect(parse('1d')).toBe(480)
    expect(parse('1 DAY')).toBe(480)
  })

  it('reads a bare number as hours, not minutes', () => {
    expect(parse('8')).toBe(480)
    expect(parse('1')).toBe(60)
    expect(parse('7.5')).toBe(450)
  })

  it('parses zero in every form', () => {
    expect(parse('0')).toBe(0)
    expect(parse('0h')).toBe(0)
    expect(parse('0m')).toBe(0)
    expect(parse('0:00')).toBe(0)
    expect(parse('0 days')).toBe(0)
  })

  it('parses signed input for ledger adjustments', () => {
    expect(parse('-4h')).toBe(-240)
    expect(parse('-0.5 days')).toBe(-240)
    expect(parse('-45m')).toBe(-45)
    expect(parse('-7:30')).toBe(-450)
    expect(parse('-7h 30m')).toBe(-450)
    expect(parse('+8h')).toBe(480)
    expect(parse('- 4h')).toBe(-240)
  })

  it('never returns a negative zero', () => {
    expect(Object.is(parse('-0'), 0)).toBe(true)
    expect(Object.is(parse('-0 days'), 0)).toBe(true)
  })

  it('rounds fractional input to a whole minute', () => {
    expect(parse('0.5h')).toBe(30)
    expect(parse('0.1h')).toBe(6)
    expect(parse('0.01h')).toBe(1)
    expect(parse('1.1 days')).toBe(528)
  })

  it('always returns an integer or null, never a float', () => {
    const inputs = ['8', '7.5', '0.1h', '1.1 days', '0.333 days', '7:30', '1.5d', 'junk']
    for (const input of inputs) {
      const result = parseDuration(input, { minutesPerDay: 450 })
      if (result !== null) {
        expect(Number.isInteger(result), `${input} -> ${result}`).toBe(true)
      }
    }
  })

  it('scales days by the employee working day', () => {
    expect(parseDuration('1 day', { minutesPerDay: PART })).toBe(240)
    expect(parseDuration('2.5 days', { minutesPerDay: PART })).toBe(600)
    expect(parseDuration('0.5d', { minutesPerDay: 450 })).toBe(225)
  })

  it('refuses days when minutesPerDay is unusable', () => {
    expect(parseDuration('1 day', { minutesPerDay: 0 })).toBeNull()
    expect(parseDuration('1 day', { minutesPerDay: Number.NaN })).toBeNull()
    // Hours still parse fine — only the day form needs the day length.
    expect(parseDuration('8h', { minutesPerDay: 0 })).toBe(480)
  })

  it('returns null for anything that is not a duration', () => {
    const garbage = [
      '',
      '   ',
      'abc',
      'h',
      'm',
      'd',
      'day',
      'days',
      '-',
      '+',
      '8x',
      '7h30x',
      '1 day 4h',
      'NaN',
      'Infinity',
      '1e3',
      '--4h',
      '8,5h',
      ':30',
      '7:',
      '::',
      '1/2 day',
    ]
    for (const input of garbage) {
      expect(parse(input), input).toBeNull()
    }
  })

  it('refuses a clock time with an impossible minutes part', () => {
    // "7:75" is a typo; guessing 8h15m would silently bank 15 extra minutes.
    expect(parse('7:75')).toBeNull()
    expect(parse('7:60')).toBeNull()
    expect(parse('7:59')).toBe(479)
    expect(parse('7:5')).toBe(425)
  })

  it('refuses a value too large to be a real duration', () => {
    expect(parse('99999999999999999999h')).toBeNull()
  })
})

describe('format → parse round trip', () => {
  const samples = [-1200, -480, -450, -277, -45, 0, 45, 120, 240, 277, 450, 480, 600, 1200]

  for (const minutesPerDay of [FULL, PART, 450]) {
    for (const unit of ['HOURS', 'DAYS'] as const) {
      it(`survives ${unit} at a ${minutesPerDay}-minute day`, () => {
        for (const minutes of samples) {
          const text = formatDuration(minutes, { unit, minutesPerDay })
          expect(parseDuration(text, { minutesPerDay }), text).toBe(minutes)
        }
      })
    }
  }
})

describe('isValidIncrement', () => {
  it('accepts positive multiples', () => {
    expect(isValidIncrement(240, 240)).toBe(true)
    expect(isValidIncrement(480, 240)).toBe(true)
    expect(isValidIncrement(2400, 240)).toBe(true)
    expect(isValidIncrement(60, 60)).toBe(true)
    expect(isValidIncrement(240, 60)).toBe(true)
  })

  it('rejects non-multiples', () => {
    expect(isValidIncrement(180, 240)).toBe(false)
    expect(isValidIncrement(90, 60)).toBe(false)
    expect(isValidIncrement(277, 240)).toBe(false)
  })

  it('rejects zero and negatives — a request is not a correction', () => {
    expect(isValidIncrement(0, 240)).toBe(false)
    expect(isValidIncrement(-240, 240)).toBe(false)
    expect(isValidIncrement(-480, 240)).toBe(false)
  })

  it('rejects anything that is not a whole number of minutes', () => {
    expect(isValidIncrement(240.5, 240)).toBe(false)
    expect(isValidIncrement(Number.NaN, 240)).toBe(false)
    expect(isValidIncrement(Number.POSITIVE_INFINITY, 240)).toBe(false)
  })

  it('validates nothing against a misconfigured increment', () => {
    expect(isValidIncrement(240, 0)).toBe(false)
    expect(isValidIncrement(240, -240)).toBe(false)
    expect(isValidIncrement(240, 240.5)).toBe(false)
    expect(isValidIncrement(240, Number.NaN)).toBe(false)
  })
})

describe('validateRequestedMinutes', () => {
  const check = (over: Partial<Parameters<typeof validateRequestedMinutes>[0]> = {}) =>
    validateRequestedMinutes({
      minutes: 240,
      incrementMinutes: 240,
      remainingBalanceMinutes: 2400,
      allowSubIncrementWhenBalanceIsLower: true,
      ...over,
    })

  it('accepts a positive multiple within balance', () => {
    expect(check()).toEqual({ ok: true })
    expect(check({ minutes: 480 })).toEqual({ ok: true })
    expect(check({ minutes: 2400 })).toEqual({ ok: true })
  })

  it('rejects zero and negative requests', () => {
    expect(check({ minutes: 0 })).toEqual({ ok: false, reason: 'not-positive' })
    expect(check({ minutes: -240 })).toEqual({ ok: false, reason: 'not-positive' })
    expect(check({ minutes: Number.NaN })).toEqual({ ok: false, reason: 'not-positive' })
  })

  it('rejects a non-multiple that is not the whole balance', () => {
    expect(check({ minutes: 180 })).toEqual({ ok: false, reason: 'not-a-multiple' })
    expect(check({ minutes: 240.5 })).toEqual({ ok: false, reason: 'not-a-multiple' })
  })

  it('rejects a multiple the employee cannot afford', () => {
    expect(check({ minutes: 480, remainingBalanceMinutes: 240 })).toEqual({
      ok: false,
      reason: 'exceeds-balance',
    })
    expect(check({ remainingBalanceMinutes: 180 })).toEqual({
      ok: false,
      reason: 'exceeds-balance',
    })
  })

  describe('stranded-balance exception', () => {
    it('accepts a request equal to a balance below one increment', () => {
      expect(check({ minutes: 180, remainingBalanceMinutes: 180 })).toEqual({ ok: true })
      expect(check({ minutes: 1, remainingBalanceMinutes: 1 })).toEqual({ ok: true })
    })

    it('is off when the org setting is off', () => {
      expect(
        check({
          minutes: 180,
          remainingBalanceMinutes: 180,
          allowSubIncrementWhenBalanceIsLower: false,
        }),
      ).toEqual({ ok: false, reason: 'not-a-multiple' })
    })

    it('only covers the entire balance, never part of it', () => {
      // 100 of a stranded 180 would leave 80 stranded behind it.
      expect(check({ minutes: 100, remainingBalanceMinutes: 180 })).toEqual({
        ok: false,
        reason: 'not-a-multiple',
      })
    })

    it('does not apply when the balance is exactly one increment', () => {
      expect(check({ minutes: 240, remainingBalanceMinutes: 240 })).toEqual({ ok: true })
      expect(check({ minutes: 180, remainingBalanceMinutes: 240 })).toEqual({
        ok: false,
        reason: 'not-a-multiple',
      })
    })

    it('does not let a balance above one increment be drained in one request', () => {
      // The exception exists to stop time being stranded, not to let anyone
      // opt out of the increment. A 500-minute balance is spent as 480 and
      // then 20 — nothing is stranded, so the exception must not fire.
      expect(check({ minutes: 500, remainingBalanceMinutes: 500 })).toEqual({
        ok: false,
        reason: 'not-a-multiple',
      })
      expect(check({ minutes: 480, remainingBalanceMinutes: 500 })).toEqual({ ok: true })
      expect(check({ minutes: 20, remainingBalanceMinutes: 20 })).toEqual({ ok: true })
    })

    it('never lets a large balance bypass the increment entirely', () => {
      // The loophole this guards: a full year's PTO requested as one
      // non-multiple entry because it happens to equal the balance.
      expect(check({ minutes: 7200, remainingBalanceMinutes: 7200 })).toEqual({
        ok: true,
      })
      expect(check({ minutes: 7130, remainingBalanceMinutes: 7130 })).toEqual({
        ok: false,
        reason: 'not-a-multiple',
      })
    })

    it('cannot be used on a zero balance', () => {
      expect(check({ minutes: 0, remainingBalanceMinutes: 0 })).toEqual({
        ok: false,
        reason: 'not-positive',
      })
      expect(check({ minutes: 240, remainingBalanceMinutes: 0 })).toEqual({
        ok: false,
        reason: 'exceeds-balance',
      })
      expect(check({ minutes: 180, remainingBalanceMinutes: 0 })).toEqual({
        ok: false,
        reason: 'not-a-multiple',
      })
    })

    it('cannot be used on a negative balance', () => {
      expect(check({ minutes: -120, remainingBalanceMinutes: -120 })).toEqual({
        ok: false,
        reason: 'not-positive',
      })
      expect(check({ minutes: 240, remainingBalanceMinutes: -120 })).toEqual({
        ok: false,
        reason: 'exceeds-balance',
      })
    })

    it('covers a part-timer whose whole day is one increment', () => {
      // 240-minute day, 240-minute increment: one option, and a stub balance
      // is only spendable through the exception.
      expect(check({ minutes: 240, remainingBalanceMinutes: 240 })).toEqual({ ok: true })
      expect(check({ minutes: 90, remainingBalanceMinutes: 90 })).toEqual({ ok: true })
      expect(check({ minutes: 240, remainingBalanceMinutes: 90 })).toEqual({
        ok: false,
        reason: 'exceeds-balance',
      })
    })
  })

  it('reports the increment problem before the balance problem', () => {
    // Both are wrong here; the documented order picks the malformed amount.
    expect(check({ minutes: 500, remainingBalanceMinutes: 300 })).toEqual({
      ok: false,
      reason: 'not-a-multiple',
    })
  })

  it('rejects everything against a misconfigured increment', () => {
    expect(check({ incrementMinutes: 0 })).toEqual({
      ok: false,
      reason: 'not-a-multiple',
    })
    // The stranded-balance exception cannot rescue it either: it requires the
    // balance to be below one increment, which no balance is when the
    // increment is nonsense. A broken setting should block requests rather
    // than silently waive the rule.
    expect(check({ incrementMinutes: 0, remainingBalanceMinutes: 240 })).toEqual({
      ok: false,
      reason: 'not-a-multiple',
    })
  })
})

describe('incrementOptions', () => {
  it('offers half and full days at a 240-minute increment', () => {
    expect(incrementOptions({ incrementMinutes: 240, minutesPerDay: FULL })).toEqual([
      { minutes: 240, label: 'Half day' },
      { minutes: 480, label: 'Full day' },
    ])
  })

  it('offers hourly choices up to a full day at a 60-minute increment', () => {
    const options = incrementOptions({ incrementMinutes: 60, minutesPerDay: FULL })
    expect(options).toHaveLength(8)
    expect(options[0]).toEqual({ minutes: 60, label: '1h' })
    expect(options[2]).toEqual({ minutes: 180, label: '3h' })
    expect(options[3]).toEqual({ minutes: 240, label: 'Half day' })
    expect(options[6]).toEqual({ minutes: 420, label: '7h' })
    expect(options.at(-1)).toEqual({ minutes: 480, label: 'Full day' })
  })

  it('offers a single choice when the increment is a whole day', () => {
    expect(incrementOptions({ incrementMinutes: 480, minutesPerDay: FULL })).toEqual([
      { minutes: 480, label: 'Full day' },
    ])
  })

  it('treats a part-timer 240-minute day as full days, not half days', () => {
    expect(incrementOptions({ incrementMinutes: 240, minutesPerDay: PART })).toEqual([
      { minutes: 240, label: 'Full day' },
    ])
  })

  it('labels the part-timer half day correctly at an hourly increment', () => {
    expect(incrementOptions({ incrementMinutes: 60, minutesPerDay: PART })).toEqual([
      { minutes: 60, label: '1h' },
      { minutes: 120, label: 'Half day' },
      { minutes: 180, label: '3h' },
      { minutes: 240, label: 'Full day' },
    ])
  })

  it('omits a day it cannot reach when the increment does not divide it', () => {
    // 300 does not divide 480, so "Full day" would be an invalid request.
    expect(incrementOptions({ incrementMinutes: 300, minutesPerDay: FULL })).toEqual([
      { minutes: 300, label: '5h' },
    ])
    expect(incrementOptions({ incrementMinutes: 90, minutesPerDay: FULL })).toEqual([
      { minutes: 90, label: '1h 30m' },
      { minutes: 180, label: '3h' },
      { minutes: 270, label: '4h 30m' },
      { minutes: 360, label: '6h' },
      { minutes: 450, label: '7h 30m' },
    ])
  })

  it('honours maxMinutes over the working day', () => {
    expect(
      incrementOptions({ incrementMinutes: 300, minutesPerDay: FULL, maxMinutes: 900 }),
    ).toEqual([
      { minutes: 300, label: '5h' },
      { minutes: 600, label: '10h' },
      { minutes: 900, label: '15h' },
    ])
    expect(
      incrementOptions({ incrementMinutes: 240, minutesPerDay: FULL, maxMinutes: 240 }),
    ).toEqual([{ minutes: 240, label: 'Half day' }])
  })

  it('never returns an empty list for a usable increment', () => {
    const cases = [
      { incrementMinutes: 600, minutesPerDay: FULL },
      { incrementMinutes: 240, minutesPerDay: FULL, maxMinutes: 100 },
      { incrementMinutes: 240, minutesPerDay: FULL, maxMinutes: 0 },
      { incrementMinutes: 240, minutesPerDay: 0 },
      { incrementMinutes: 240, minutesPerDay: Number.NaN },
    ]
    for (const args of cases) {
      const options = incrementOptions(args)
      expect(options.length, JSON.stringify(args)).toBeGreaterThan(0)
      for (const option of options) {
        expect(option.label).not.toBe('')
      }
    }
  })

  it('offers only valid increments', () => {
    for (const incrementMinutes of [15, 60, 90, 240, 300, 480, 600]) {
      for (const minutesPerDay of [240, 450, 480]) {
        for (const option of incrementOptions({ incrementMinutes, minutesPerDay })) {
          expect(
            isValidIncrement(option.minutes, incrementMinutes),
            `${option.minutes} @ ${incrementMinutes}`,
          ).toBe(true)
        }
      }
    }
  })

  it('returns nothing for a misconfigured increment', () => {
    expect(incrementOptions({ incrementMinutes: 0, minutesPerDay: FULL })).toEqual([])
    expect(incrementOptions({ incrementMinutes: -60, minutesPerDay: FULL })).toEqual([])
    expect(incrementOptions({ incrementMinutes: 90.5, minutesPerDay: FULL })).toEqual([])
    expect(
      incrementOptions({ incrementMinutes: Number.NaN, minutesPerDay: FULL }),
    ).toEqual([])
  })
})
