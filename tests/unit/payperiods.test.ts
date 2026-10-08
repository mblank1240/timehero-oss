import { afterEach, describe, expect, it } from 'vitest'

import {
  generatePeriods,
  periodContaining,
  periodsPerYear,
  type GeneratedPeriod,
  type PayScheduleInput,
  type PayScheduleType,
} from '@/lib/payperiods/generate'

const MS_PER_DAY = 86_400_000

/** A DATE column value: UTC midnight, no time-of-day. */
function d(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`)
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function rows(periods: GeneratedPeriod[]): string[][] {
  return periods.map((p) => [iso(p.startDate), iso(p.endDate), iso(p.payDate)])
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY)
}

function schedule(
  type: PayScheduleType,
  anchor: string,
  payDateOffsetDays = 5,
): PayScheduleInput {
  return { type, anchorDate: d(anchor), payDateOffsetDays }
}

/**
 * The invariants every caller depends on, asserted programmatically so a long
 * range is checked in full rather than spot-checked: UTC-midnight dates, an
 * inclusive end on or after the start, the configured pay-date offset, and
 * contiguity with no gap and no overlap.
 */
function assertWellFormed(periods: GeneratedPeriod[], s: PayScheduleInput): void {
  expect(periods.length).toBeGreaterThan(0)

  for (const [i, p] of periods.entries()) {
    for (const [label, value] of Object.entries(p)) {
      expect(`${label}@${i} ${value.toISOString()}`).toBe(
        `${label}@${i} ${iso(value)}T00:00:00.000Z`,
      )
    }

    expect(p.endDate.getTime()).toBeGreaterThanOrEqual(p.startDate.getTime())
    expect(iso(p.payDate)).toBe(iso(addDays(p.endDate, s.payDateOffsetDays)))

    if (i > 0) {
      const previous = periods[i - 1]
      // Contiguous: the next period starts the day after the inclusive end.
      expect(`${i}:${iso(p.startDate)}`).toBe(`${i}:${iso(addDays(previous.endDate, 1))}`)
    }
  }
}

describe('periodsPerYear', () => {
  it('returns the nominal divisor for each type', () => {
    expect(periodsPerYear('WEEKLY')).toBe(52)
    expect(periodsPerYear('BIWEEKLY')).toBe(26)
    expect(periodsPerYear('SEMI_MONTHLY')).toBe(24)
    expect(periodsPerYear('MONTHLY')).toBe(12)
  })

  it('throws on an unknown type rather than returning undefined', () => {
    expect(() => periodsPerYear('FORTNIGHTLY' as PayScheduleType)).toThrow(/Unknown pay schedule type/)
  })
})

describe('generatePeriods — WEEKLY', () => {
  const s = schedule('WEEKLY', '2026-01-05', 3)

  it('lays 7-day periods off the anchor', () => {
    const periods = generatePeriods(s, { from: d('2026-01-05'), through: d('2026-02-01') })
    expect(rows(periods)).toEqual([
      ['2026-01-05', '2026-01-11', '2026-01-14'],
      ['2026-01-12', '2026-01-18', '2026-01-21'],
      ['2026-01-19', '2026-01-25', '2026-01-28'],
      ['2026-01-26', '2026-02-01', '2026-02-04'],
    ])
  })

  it('produces exactly 52 periods over 364 days', () => {
    const periods = generatePeriods(s, {
      from: d('2026-01-05'),
      through: addDays(d('2026-01-05'), 363),
    })
    expect(periods).toHaveLength(52)
    assertWellFormed(periods, s)
  })

  it('spans 29 February without shifting', () => {
    const leap = schedule('WEEKLY', '2024-02-26', 0)
    const periods = generatePeriods(leap, { from: d('2024-02-26'), through: d('2024-03-10') })
    expect(rows(periods)).toEqual([
      ['2024-02-26', '2024-03-03', '2024-03-03'],
      ['2024-03-04', '2024-03-10', '2024-03-10'],
    ])
  })
})

describe('generatePeriods — BIWEEKLY', () => {
  const s = schedule('BIWEEKLY', '2026-01-04', 5)

  it('lays 14-day periods off the anchor', () => {
    const periods = generatePeriods(s, { from: d('2026-01-04'), through: d('2026-02-14') })
    expect(rows(periods)).toEqual([
      ['2026-01-04', '2026-01-17', '2026-01-22'],
      ['2026-01-18', '2026-01-31', '2026-02-05'],
      ['2026-02-01', '2026-02-14', '2026-02-19'],
    ])
  })

  it('produces exactly 26 periods over 364 days — the church default', () => {
    const periods = generatePeriods(s, {
      from: d('2026-01-04'),
      through: addDays(d('2026-01-04'), 363),
    })
    expect(periods).toHaveLength(26)
    expect(periods).toHaveLength(periodsPerYear('BIWEEKLY'))
    assertWellFormed(periods, s)
  })

  it('does not leave a gap at 31 December / 1 January', () => {
    const periods = generatePeriods(s, { from: d('2026-01-04'), through: d('2028-06-30') })
    assertWellFormed(periods, s)

    const crossing = periods.filter(
      (p) => p.startDate.getUTCFullYear() !== p.endDate.getUTCFullYear(),
    )
    // Two year boundaries in range, each inside a period rather than between two.
    expect(rows(crossing)).toEqual([
      ['2026-12-20', '2027-01-02', '2027-01-07'],
      ['2027-12-19', '2028-01-01', '2028-01-06'],
    ])

    // Every 31 December in range is covered exactly once.
    for (const year of [2026, 2027]) {
      const covering = periods.filter(
        (p) => p.startDate <= d(`${year}-12-31`) && p.endDate >= d(`${year}-12-31`),
      )
      expect(covering).toHaveLength(1)
    }
  })

  it('spans 29 February in a leap year', () => {
    const leap = schedule('BIWEEKLY', '2024-02-19', 2)
    const periods = generatePeriods(leap, { from: d('2024-02-19'), through: d('2024-03-03') })
    expect(rows(periods)).toEqual([['2024-02-19', '2024-03-03', '2024-03-05']])

    // The same grid in a non-leap year lands a day earlier on the calendar.
    const common = schedule('BIWEEKLY', '2026-02-19', 2)
    expect(rows(generatePeriods(common, { from: d('2026-02-19'), through: d('2026-03-04') }))).toEqual([
      ['2026-02-19', '2026-03-04', '2026-03-06'],
    ])
  })

  it('stays contiguous over 24 months and does not loop unboundedly', () => {
    const started = Date.now()
    const periods = generatePeriods(s, { from: d('2026-01-04'), through: d('2028-01-03') })
    const elapsed = Date.now() - started

    assertWellFormed(periods, s)
    expect(periods).toHaveLength(53) // 731 days / 14, plus the period straddling the end
    expect(iso(periods[0].startDate)).toBe('2026-01-04')
    expect(periods[periods.length - 1].endDate.getTime()).toBeGreaterThanOrEqual(
      d('2028-01-03').getTime(),
    )
    expect(elapsed).toBeLessThan(250)
  })
})

describe('generatePeriods — SEMI_MONTHLY', () => {
  const s = schedule('SEMI_MONTHLY', '2026-01-01', 5)

  it('splits each month at the 15th/16th', () => {
    const periods = generatePeriods(s, { from: d('2026-01-01'), through: d('2026-02-28') })
    expect(rows(periods)).toEqual([
      ['2026-01-01', '2026-01-15', '2026-01-20'],
      ['2026-01-16', '2026-01-31', '2026-02-05'],
      ['2026-02-01', '2026-02-15', '2026-02-20'],
      ['2026-02-16', '2026-02-28', '2026-03-05'],
    ])
  })

  it('ends the second half on the real last day for 28, 29, 30 and 31-day months', () => {
    const leapYear = schedule('SEMI_MONTHLY', '2024-01-01', 0)
    const periods = generatePeriods(leapYear, { from: d('2024-01-01'), through: d('2024-12-31') })

    expect(periods).toHaveLength(24)
    expect(periods).toHaveLength(periodsPerYear('SEMI_MONTHLY'))
    assertWellFormed(periods, leapYear)

    const secondHalfEnds = periods
      .filter((p) => p.startDate.getUTCDate() === 16)
      .map((p) => iso(p.endDate))
    expect(secondHalfEnds).toEqual([
      '2024-01-31',
      '2024-02-29', // leap year
      '2024-03-31',
      '2024-04-30',
      '2024-05-31',
      '2024-06-30',
      '2024-07-31',
      '2024-08-31',
      '2024-09-30',
      '2024-10-31',
      '2024-11-30',
      '2024-12-31',
    ])
  })

  it('handles February in a common year, a leap year and a century non-leap year', () => {
    const february = (year: number) =>
      rows(
        generatePeriods(schedule('SEMI_MONTHLY', `${year}-01-01`, 0), {
          from: d(`${year}-02-01`),
          through: d(`${year}-02-28`),
        }),
      )

    expect(february(2026)).toEqual([
      ['2026-02-01', '2026-02-15', '2026-02-15'],
      ['2026-02-16', '2026-02-28', '2026-02-28'],
    ])
    expect(february(2024)).toEqual([
      ['2024-02-01', '2024-02-15', '2024-02-15'],
      ['2024-02-16', '2024-02-29', '2024-02-29'],
    ])
    // 2100 is divisible by 100 but not 400, so February has 28 days.
    expect(february(2100)).toEqual([
      ['2100-02-01', '2100-02-15', '2100-02-15'],
      ['2100-02-16', '2100-02-28', '2100-02-28'],
    ])
  })

  it('stays contiguous across a year boundary and over 24 months', () => {
    const periods = generatePeriods(s, { from: d('2026-01-01'), through: d('2027-12-31') })
    assertWellFormed(periods, s)
    expect(periods).toHaveLength(48)
    expect(rows(periods.slice(23, 25))).toEqual([
      ['2026-12-16', '2026-12-31', '2027-01-05'],
      ['2027-01-01', '2027-01-15', '2027-01-20'],
    ])
  })
})

describe('generatePeriods — MONTHLY', () => {
  const s = schedule('MONTHLY', '2026-01-01', 2)

  it('runs the 1st to the last day of each calendar month', () => {
    const periods = generatePeriods(s, { from: d('2026-01-01'), through: d('2026-12-31') })
    expect(periods).toHaveLength(12)
    expect(periods).toHaveLength(periodsPerYear('MONTHLY'))
    assertWellFormed(periods, s)
    expect(rows(periods.slice(0, 3))).toEqual([
      ['2026-01-01', '2026-01-31', '2026-02-02'],
      ['2026-02-01', '2026-02-28', '2026-03-02'],
      ['2026-03-01', '2026-03-31', '2026-04-02'],
    ])
    expect(rows(periods.slice(-1))).toEqual([['2026-12-01', '2026-12-31', '2027-01-02']])
  })

  it('ends February on the 29th in a leap year', () => {
    const leap = schedule('MONTHLY', '2024-01-01', 0)
    const periods = generatePeriods(leap, { from: d('2024-02-01'), through: d('2024-02-29') })
    expect(rows(periods)).toEqual([['2024-02-01', '2024-02-29', '2024-02-29']])
  })

  it('stays contiguous over 24 months', () => {
    const periods = generatePeriods(s, { from: d('2026-01-01'), through: d('2027-12-31') })
    assertWellFormed(periods, s)
    expect(periods).toHaveLength(24)
  })
})

describe('generatePeriods — range handling', () => {
  const biweekly = schedule('BIWEEKLY', '2026-01-04', 5)

  it('includes any period that overlaps the range, even partially', () => {
    // Both ends land mid-period; both periods come back whole.
    const periods = generatePeriods(biweekly, { from: d('2026-01-10'), through: d('2026-01-20') })
    expect(rows(periods)).toEqual([
      ['2026-01-04', '2026-01-17', '2026-01-22'],
      ['2026-01-18', '2026-01-31', '2026-02-05'],
    ])
  })

  it('returns the single containing period for a one-day range', () => {
    const periods = generatePeriods(biweekly, { from: d('2026-01-10'), through: d('2026-01-10') })
    expect(rows(periods)).toEqual([['2026-01-04', '2026-01-17', '2026-01-22']])
  })

  it('includes the period containing the first and last day of the range exactly once', () => {
    const periods = generatePeriods(biweekly, { from: d('2026-01-17'), through: d('2026-01-18') })
    expect(periods).toHaveLength(2)
  })

  it('returns nothing when through precedes from', () => {
    expect(generatePeriods(biweekly, { from: d('2026-06-01'), through: d('2026-05-31') })).toEqual([])
  })

  it('ignores a time-of-day on the range bounds', () => {
    const withTime = generatePeriods(biweekly, {
      from: new Date('2026-01-10T23:59:59.999Z'),
      through: new Date('2026-01-20T00:00:01.000Z'),
    })
    expect(rows(withTime)).toEqual(
      rows(generatePeriods(biweekly, { from: d('2026-01-10'), through: d('2026-01-20') })),
    )
  })

  it('throws on an invalid date rather than generating garbage', () => {
    expect(() => generatePeriods(biweekly, { from: new Date('nope'), through: d('2026-01-20') })).toThrow(
      /valid Date/,
    )
  })
})

describe('generatePeriods — anchor handling', () => {
  it('never generates a period before a WEEKLY anchor that falls mid-range', () => {
    const s = schedule('WEEKLY', '2026-06-01', 0)
    const periods = generatePeriods(s, { from: d('2026-01-01'), through: d('2026-06-30') })

    expect(iso(periods[0].startDate)).toBe('2026-06-01')
    for (const p of periods) {
      expect(p.startDate.getTime()).toBeGreaterThanOrEqual(d('2026-06-01').getTime())
    }
    assertWellFormed(periods, s)
  })

  it('snaps a mid-month SEMI_MONTHLY anchor back to its calendar boundary', () => {
    // Documented choice: calendar schedules keep whole periods, so an anchor
    // of the 10th means "start with the half-month containing the 10th".
    const s = schedule('SEMI_MONTHLY', '2026-06-10', 0)
    const periods = generatePeriods(s, { from: d('2026-01-01'), through: d('2026-07-31') })

    expect(rows(periods)).toEqual([
      ['2026-06-01', '2026-06-15', '2026-06-15'],
      ['2026-06-16', '2026-06-30', '2026-06-30'],
      ['2026-07-01', '2026-07-15', '2026-07-15'],
      ['2026-07-16', '2026-07-31', '2026-07-31'],
    ])
    // Nothing ends before the anchor, so no period is wholly in the past.
    for (const p of periods) {
      expect(p.endDate.getTime()).toBeGreaterThanOrEqual(d('2026-06-10').getTime())
    }
  })

  it('snaps a mid-month MONTHLY anchor back to the 1st', () => {
    const s = schedule('MONTHLY', '2026-06-18', 0)
    expect(rows(generatePeriods(s, { from: d('2026-01-01'), through: d('2026-06-30') }))).toEqual([
      ['2026-06-01', '2026-06-30', '2026-06-30'],
    ])
  })

  it('returns nothing when the schedule starts after the range', () => {
    const s = schedule('BIWEEKLY', '2027-01-03', 5)
    expect(generatePeriods(s, { from: d('2026-01-01'), through: d('2026-12-31') })).toEqual([])
  })

  it('ignores a time-of-day on the anchor', () => {
    const clean = schedule('BIWEEKLY', '2026-01-04', 5)
    const messy: PayScheduleInput = {
      type: 'BIWEEKLY',
      anchorDate: new Date('2026-01-04T18:30:00.000Z'),
      payDateOffsetDays: 5,
    }
    const args = { from: d('2026-01-01'), through: d('2026-04-01') }
    expect(rows(generatePeriods(messy, args))).toEqual(rows(generatePeriods(clean, args)))
  })
})

describe('generatePeriods — pay dates', () => {
  it('pays on the end date with a zero offset', () => {
    const s = schedule('MONTHLY', '2026-01-01', 0)
    const [period] = generatePeriods(s, { from: d('2026-01-01'), through: d('2026-01-31') })
    expect(iso(period.payDate)).toBe(iso(period.endDate))
  })

  it('carries the pay date into the next month, year and leap day', () => {
    expect(
      rows(
        generatePeriods(schedule('MONTHLY', '2026-12-01', 5), {
          from: d('2026-12-01'),
          through: d('2026-12-31'),
        }),
      ),
    ).toEqual([['2026-12-01', '2026-12-31', '2027-01-05']])

    // End 28 February in a leap year + 1 day lands on the 29th, not 1 March.
    expect(
      rows(
        generatePeriods(schedule('BIWEEKLY', '2024-02-15', 1), {
          from: d('2024-02-15'),
          through: d('2024-02-28'),
        }),
      ),
    ).toEqual([['2024-02-15', '2024-02-28', '2024-02-29']])
  })

  it('rejects a nonsensical offset instead of silently normalising it', () => {
    const args = { from: d('2026-01-01'), through: d('2026-01-31') }
    expect(() => generatePeriods(schedule('MONTHLY', '2026-01-01', -1), args)).toThrow(
      /non-negative integer/,
    )
    expect(() => generatePeriods(schedule('MONTHLY', '2026-01-01', 1.5), args)).toThrow(
      /non-negative integer/,
    )
  })

  it('rejects an unknown schedule type', () => {
    expect(() =>
      generatePeriods(schedule('QUARTERLY' as PayScheduleType, '2026-01-01', 0), {
        from: d('2026-01-01'),
        through: d('2026-12-31'),
      }),
    ).toThrow(/Unknown pay schedule type/)
  })
})

describe('generatePeriods — determinism', () => {
  const types: PayScheduleType[] = ['WEEKLY', 'BIWEEKLY', 'SEMI_MONTHLY', 'MONTHLY']

  it('returns identical results for the same range twice', () => {
    for (const type of types) {
      const s = schedule(type, '2026-01-04', 5)
      const args = { from: d('2026-01-01'), through: d('2027-12-31') }
      const first = generatePeriods(s, args)
      const second = generatePeriods(s, args)

      expect(first).toEqual(second)
      // Fresh Date objects each call — the job must never hand out shared refs.
      expect(first[0].startDate).not.toBe(second[0].startDate)
    }
  })

  it('agrees with itself when a long range is generated in two halves', () => {
    for (const type of types) {
      const s = schedule(type, '2026-01-04', 3)
      const whole = rows(generatePeriods(s, { from: d('2026-01-01'), through: d('2027-12-31') }))
      const firstHalf = rows(generatePeriods(s, { from: d('2026-01-01'), through: d('2026-12-31') }))
      const secondHalf = rows(generatePeriods(s, { from: d('2027-01-01'), through: d('2027-12-31') }))

      // The halves overlap by at most the period straddling the split.
      const stitched = [...firstHalf, ...secondHalf.filter((r) => !firstHalf.some((f) => f[0] === r[0]))]
      expect(stitched).toEqual(whole)
    }
  })
})

describe('generatePeriods — timezone independence', () => {
  const originalTz = process.env.TZ

  afterEach(() => {
    process.env.TZ = originalTz
  })

  it('produces the same periods whatever the machine timezone is', () => {
    // DST boundaries and a +14/-11 pair: nothing below may read local time.
    const zones = ['UTC', 'America/New_York', 'Pacific/Kiritimati', 'Pacific/Niue', 'Australia/Lord_Howe']
    const results = zones.map((tz) => {
      process.env.TZ = tz
      return zones.flatMap(() =>
        (['WEEKLY', 'BIWEEKLY', 'SEMI_MONTHLY', 'MONTHLY'] as PayScheduleType[]).flatMap((type) =>
          rows(
            generatePeriods(schedule(type, '2026-03-01', 5), {
              // Spans the US and EU DST switches in both hemispheres.
              from: d('2026-03-01'),
              through: d('2026-11-30'),
            }),
          ),
        ),
      )
    })

    for (const result of results) expect(result).toEqual(results[0])
  })

  it('keeps every emitted date at exact UTC midnight', () => {
    process.env.TZ = 'America/Los_Angeles'
    const s = schedule('SEMI_MONTHLY', '2026-01-01', 5)
    for (const p of generatePeriods(s, { from: d('2026-01-01'), through: d('2026-12-31') })) {
      expect(p.startDate.getTime() % MS_PER_DAY).toBe(0)
      expect(p.endDate.getTime() % MS_PER_DAY).toBe(0)
      expect(p.payDate.getTime() % MS_PER_DAY).toBe(0)
    }
  })
})

describe('periodContaining', () => {
  it('returns null for a date before the schedule starts', () => {
    const s = schedule('BIWEEKLY', '2026-01-04', 5)
    expect(periodContaining(s, d('2026-01-03'))).toBeNull()
    expect(periodContaining(s, d('2020-01-01'))).toBeNull()
  })

  it('returns the period for the anchor day itself', () => {
    const s = schedule('BIWEEKLY', '2026-01-04', 5)
    expect(rows([periodContaining(s, d('2026-01-04'))!])).toEqual([
      ['2026-01-04', '2026-01-17', '2026-01-22'],
    ])
  })

  it('handles the first and last day of a period', () => {
    const s = schedule('SEMI_MONTHLY', '2024-01-01', 0)
    expect(iso(periodContaining(s, d('2024-02-16'))!.startDate)).toBe('2024-02-16')
    expect(iso(periodContaining(s, d('2024-02-29'))!.endDate)).toBe('2024-02-29')
    expect(iso(periodContaining(s, d('2024-02-15'))!.endDate)).toBe('2024-02-15')
  })

  it('agrees with generatePeriods for every day of a two-year span', () => {
    for (const type of (['WEEKLY', 'BIWEEKLY', 'SEMI_MONTHLY', 'MONTHLY'] as PayScheduleType[])) {
      const s = schedule(type, '2024-01-01', 4) // starts in a leap year
      const periods = generatePeriods(s, { from: d('2024-01-01'), through: d('2025-12-31') })
      const byDay = new Map<string, string[]>()
      for (const p of periods) {
        for (let t = p.startDate.getTime(); t <= p.endDate.getTime(); t += MS_PER_DAY) {
          const key = iso(new Date(t))
          // Every day belongs to exactly one period — proves no overlap.
          expect(byDay.has(key)).toBe(false)
          byDay.set(key, [iso(p.startDate), iso(p.endDate), iso(p.payDate)])
        }
      }

      for (let t = d('2024-01-01').getTime(); t <= d('2025-12-31').getTime(); t += MS_PER_DAY) {
        const date = new Date(t)
        // Every day in range is covered — proves no gap.
        expect(byDay.get(iso(date))).toBeDefined()
        expect(rows([periodContaining(s, date)!])[0]).toEqual(byDay.get(iso(date)))
      }
    }
  })

  it('ignores a time-of-day on the probe date', () => {
    const s = schedule('MONTHLY', '2026-01-01', 2)
    expect(periodContaining(s, new Date('2026-03-15T22:10:00.000Z'))).toEqual(
      periodContaining(s, d('2026-03-15')),
    )
  })
})
