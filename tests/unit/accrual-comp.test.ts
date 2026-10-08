import { describe, expect, it } from 'vitest'

import { benefitYearStartingIn } from '@/lib/accrual/dates'
import { compMinutes, planCompEarned, type CompPlanArgs } from '@/lib/accrual/comp'
import { expireLots } from '@/lib/accrual/expiry'

import {
  asExisting,
  d,
  employee,
  entry,
  leaveType,
  rows,
  window as carryoverWindow,
} from './support/accrual'

const Y2026 = benefitYearStartingIn(2026, 1, 1)
const Y2027 = benefitYearStartingIn(2027, 1, 1)

/** The church's comp setup: nothing carries under the rule, December rescued until February. */
function args(overrides: Partial<CompPlanArgs> & { date: string; minutes: number }): CompPlanArgs {
  const { date, minutes, ...rest } = overrides
  return {
    log: { id: 'log1', employeeId: 'emp', date: d(date), minutes },
    leaveTypeId: 'comp',
    multiplierBps: 10_000,
    expiresAfterDays: null,
    currentYear: Y2027,
    previousYear: Y2026,
    employee: employee(),
    leaveType: leaveType({ id: 'comp', countsTowardRollover: false }),
    rule: { capBasis: 'NONE', capValue: 0, carriedExpiresAfterDays: null },
    windows: [carryoverWindow()],
    entries: [],
    ...rest,
  }
}

describe('compMinutes', () => {
  it('is the time worked at 1.0x', () => {
    expect(compMinutes(135, 10_000)).toBe(135)
  })

  it('applies a multiplier in basis points', () => {
    expect(compMinutes(120, 15_000)).toBe(180)
    expect(compMinutes(60, 20_000)).toBe(120)
  })

  it('rounds a half-minute up, in the employee’s favour', () => {
    // 15 × 1.5 = 22.5
    expect(compMinutes(15, 15_000)).toBe(23)
    // 15 × 1.25 = 18.75
    expect(compMinutes(15, 12_500)).toBe(19)
    // 15 × 1.1 = 16.5
    expect(compMinutes(15, 11_000)).toBe(17)
  })

  it('banks nothing at a zero multiplier', () => {
    expect(compMinutes(480, 0)).toBe(0)
  })
})

describe('planCompEarned — worked this benefit year', () => {
  it('is one COMP_EARNED entry on the day worked, keyed to the log', () => {
    const plan = planCompEarned(args({ date: '2027-03-10', minutes: 135 }))

    expect(rows(plan.entries)).toEqual(['2027-03-10 +135 COMP_EARNED exp=- key=OT-log1'])
    expect(plan.entries[0]).toMatchObject({ sourceType: 'OvertimeLog', sourceId: 'log1' })
    expect(plan.earnedMinutes).toBe(135)
    expect(plan.explanation).toBeNull()
  })

  it('applies the multiplier', () => {
    const plan = planCompEarned(args({ date: '2027-03-10', minutes: 120, multiplierBps: 15_000 }))
    expect(plan.grossMinutes).toBe(180)
    expect(plan.earnedMinutes).toBe(180)
  })

  it('stamps the optional expiry, counted from the day worked', () => {
    const plan = planCompEarned(args({ date: '2027-03-10', minutes: 60, expiresAfterDays: 90 }))
    expect(rows(plan.entries)).toEqual(['2027-03-10 +60 COMP_EARNED exp=2027-06-08 key=OT-log1'])
  })

  it('is forfeited by expire-lots once the expiry passes, net of what was spent', () => {
    const plan = planCompEarned(args({ date: '2027-03-10', minutes: 240, expiresAfterDays: 90 }))
    const ledger = [...asExisting(plan.entries), entry('2027-04-02', -60, 'USAGE')]

    expect(expireLots({ employee: employee(), leaveTypeId: 'comp', entries: ledger, asOf: d('2027-06-08') })).toEqual([])
    expect(
      rows(expireLots({ employee: employee(), leaveTypeId: 'comp', entries: ledger, asOf: d('2027-06-09') })),
    ).toEqual(['2027-06-09 -180 FORFEIT exp=- key=p0000-EXPIRY'])
  })

  it('writes nothing at a zero multiplier', () => {
    const plan = planCompEarned(args({ date: '2027-03-10', minutes: 60, multiplierBps: 0 }))
    expect(plan.entries).toEqual([])
    expect(plan.earnedMinutes).toBe(0)
  })
})

describe('planCompEarned — worked in a year that has since closed', () => {
  it('banks December overtime on 1 January with the window’s February expiry', () => {
    const plan = planCompEarned(args({ date: '2026-12-20', minutes: 240 }))

    expect(rows(plan.entries)).toEqual(['2027-01-01 +240 COMP_EARNED exp=2027-02-28 key=OT-log1'])
    expect(plan.earnedMinutes).toBe(240)
    expect(plan.explanation).toBeNull()
  })

  it('banks nothing for November overtime, which the rollover would have forfeited', () => {
    const plan = planCompEarned(args({ date: '2026-11-20', minutes: 240 }))

    expect(plan.entries).toEqual([])
    expect(plan.grossMinutes).toBe(240)
    expect(plan.earnedMinutes).toBe(0)
    expect(plan.explanation).toMatch(/would have kept 0 of the 240/)
  })

  it('is unaffected by comp the rollover has already carried', () => {
    // 480 earned in December and already carried on 1 January.
    const entries = [
      entry('2026-12-05', 480, 'COMP_EARNED'),
      entry('2027-01-01', -480, 'FORFEIT'),
      entry('2027-01-01', 480, 'ROLLOVER_IN', { expiresOn: '2027-02-28' }),
    ]
    const plan = planCompEarned(args({ date: '2026-12-20', minutes: 120, entries }))
    expect(rows(plan.entries)).toEqual(['2027-01-01 +120 COMP_EARNED exp=2027-02-28 key=OT-log1'])
  })

  it('respects a window cap the existing carry has already used up', () => {
    const entries = [entry('2026-12-05', 480, 'COMP_EARNED')]
    const plan = planCompEarned(
      args({
        date: '2026-12-20',
        minutes: 240,
        entries,
        windows: [carryoverWindow({ capBasis: 'FIXED_MINUTES', capValue: 600 })],
      }),
    )
    // 480 already fits under the 600 cap; only 120 of the new 240 does.
    expect(rows(plan.entries)).toEqual(['2027-01-01 +120 COMP_EARNED exp=2027-02-28 key=OT-log1'])
    expect(plan.explanation).toMatch(/would have kept 120 of the 240/)
  })

  it('carries under the base rule, with its own expiry, when the type rolls over', () => {
    const plan = planCompEarned(
      args({
        date: '2026-06-15',
        minutes: 300,
        leaveType: leaveType({ id: 'comp', countsTowardRollover: true }),
        rule: { capBasis: 'UNLIMITED', capValue: 0, carriedExpiresAfterDays: 30 },
        windows: [],
      }),
    )
    expect(rows(plan.entries)).toEqual(['2027-01-01 +300 COMP_EARNED exp=2027-01-31 key=OT-log1'])
  })

  it('takes the earlier of the carried expiry and the log’s own', () => {
    const plan = planCompEarned(args({ date: '2026-12-20', minutes: 60, expiresAfterDays: 45 }))
    // Own expiry 2027-02-03 beats the window's 2027-02-28.
    expect(rows(plan.entries)).toEqual(['2027-01-01 +60 COMP_EARNED exp=2027-02-03 key=OT-log1'])
  })

  it('carries nothing whose own expiry passed before the year turned', () => {
    const plan = planCompEarned(args({ date: '2026-12-02', minutes: 60, expiresAfterDays: 7 }))
    expect(plan.entries).toEqual([])
  })

  it('carries nothing through two rollovers', () => {
    const plan = planCompEarned(args({ date: '2025-12-20', minutes: 240 }))
    expect(plan.entries).toEqual([])
    expect(plan.explanation).toMatch(/two rollovers/)
  })

  it('uses the right February in a non-calendar benefit year', () => {
    const plan = planCompEarned(
      args({
        date: '2026-12-20',
        minutes: 60,
        // A July benefit year: December 2026 is in 2026-27, still open in March 2027.
        currentYear: benefitYearStartingIn(2026, 7, 1),
        previousYear: benefitYearStartingIn(2025, 7, 1),
      }),
    )
    expect(rows(plan.entries)).toEqual(['2026-12-20 +60 COMP_EARNED exp=- key=OT-log1'])
  })
})
