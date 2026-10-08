import { describe, expect, it } from 'vitest'

import { checkDays, type DayRulesInput } from '@/lib/requests/validate'

/** Every figure is the church's: a 240-minute increment on a 480-minute day. */
function input(overrides: Partial<DayRulesInput>): DayRulesInput {
  return {
    days: [],
    incrementMinutes: 240,
    allowSubIncrementWhenBalanceIsLower: true,
    minutesPerDay: 480,
    holidays: new Map(),
    bookedMinutes: new Map(),
    availableMinutes: 7200,
    ...overrides,
  }
}

const one = (minutes: number) => [{ date: '2026-10-12', minutes }]

describe('checkDays', () => {
  it('accepts half days and full days', () => {
    expect(
      checkDays(
        input({
          days: [
            { date: '2026-10-12', minutes: 240 },
            { date: '2026-10-13', minutes: 480 },
          ],
        }),
      ),
    ).toEqual({})
  })

  it('rejects three hours at a half-day increment', () => {
    expect(checkDays(input({ days: one(180) }))['day.2026-10-12']).toBeDefined()
  })

  describe('the stranded-balance exception', () => {
    it('accepts a lone day equal to a balance below one increment', () => {
      expect(checkDays(input({ days: one(180), availableMinutes: 180 }))).toEqual({})
    })

    it('refuses it when the balance is not exactly the request', () => {
      expect(checkDays(input({ days: one(180), availableMinutes: 200 }))).not.toEqual({})
    })

    it('refuses it when the setting is off', () => {
      expect(
        checkDays(
          input({
            days: one(180),
            availableMinutes: 180,
            allowSubIncrementWhenBalanceIsLower: false,
          }),
        ),
      ).not.toEqual({})
    })

    it('refuses it across more than one day', () => {
      const days = [
        { date: '2026-10-12', minutes: 90 },
        { date: '2026-10-13', minutes: 90 },
      ]
      expect(Object.keys(checkDays(input({ days, availableMinutes: 180 })))).toHaveLength(2)
    })
  })

  it('leaves an unaffordable but well-formed day to the balance check', () => {
    expect(checkDays(input({ days: one(480), availableMinutes: 0 }))).toEqual({})
  })

  it('refuses a holiday by name', () => {
    const errors = checkDays(
      input({ days: one(480), holidays: new Map([['2026-10-12', 'Founders Day']]) }),
    )
    expect(errors['day.2026-10-12']?.[0]).toMatch(/Founders Day/)
  })

  it('refuses more than a working day on one date, counting what is already booked', () => {
    expect(
      checkDays(input({ days: one(240), bookedMinutes: new Map([['2026-10-12', 240]]) })),
    ).toEqual({})
    expect(
      checkDays(input({ days: one(480), bookedMinutes: new Map([['2026-10-12', 240]]) }))[
        'day.2026-10-12'
      ],
    ).toBeDefined()
  })

  it('lets a part-timer whose day is one increment request it', () => {
    expect(checkDays(input({ days: one(240), minutesPerDay: 240 }))).toEqual({})
    expect(checkDays(input({ days: one(480), minutesPerDay: 240 }))).not.toEqual({})
  })
})
