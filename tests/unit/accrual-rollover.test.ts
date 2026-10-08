import { describe, expect, it } from 'vitest'

import { balanceOf } from '@/lib/accrual/balance'
import { benefitYearStartingIn } from '@/lib/accrual/dates'
import { expireLots } from '@/lib/accrual/expiry'
import { applyCap, runRollover, type RolloverArgs } from '@/lib/accrual/rollover'
import type { ExistingEntry } from '@/lib/accrual/types'

import {
  asExisting,
  d,
  employee,
  entry,
  iso,
  leaveType,
  policy,
  rows,
  window as carryoverWindow,
} from './support/accrual'

const calendarYear = (year: number) => benefitYearStartingIn(year, 1, 1)

function rollover(overrides: Partial<RolloverArgs> = {}) {
  return runRollover({
    employee: employee(),
    leaveType: leaveType(),
    rule: { capBasis: 'UNLIMITED', capValue: 0, carriedExpiresAfterDays: null },
    windows: [],
    policy: null,
    entries: [],
    closingYear: calendarYear(2026),
    newYear: calendarYear(2027),
    ...overrides,
  })
}

describe('runRollover — zero out, then re-grant', () => {
  /**
   * The bug an earlier draft of the spec had. A balance is a cumulative SUM,
   * so it carries into the new year on its own: writing a ROLLOVER_IN without
   * first forfeiting the whole closing balance doubles everyone's time.
   */
  it('does not double a balance under an unlimited cap', () => {
    const entries = [entry('2026-01-01', 200, 'LUMP_GRANT')]
    const result = rollover({ entries })

    expect(rows(result.entries)).toEqual([
      '2027-01-01 -200 FORFEIT exp=- key=2027-ROLLOVER',
      '2027-01-01 +200 ROLLOVER_IN exp=- key=2027-ROLLOVER',
    ])

    const after = [...entries, ...asExisting(result.entries)]
    expect(balanceOf(after, d('2027-01-01'))).toBe(200)
    expect(balanceOf(after, d('2027-01-01'))).not.toBe(400)
  })

  it('forfeits the closing balance before granting the carry, always', () => {
    const result = rollover({
      entries: [entry('2026-01-01', 7200, 'LUMP_GRANT')],
      rule: { capBasis: 'EMPLOYEE_DAYS', capValue: 5, carriedExpiresAfterDays: null },
    })

    expect(result.entries[0].kind).toBe('FORFEIT')
    expect(result.entries[0].minutes).toBe(-7200)
    expect(result.entries[1].kind).toBe('ROLLOVER_IN')
  })

  it('writes nothing when the closing balance is zero or negative', () => {
    expect(rollover({ entries: [] }).entries).toEqual([])
    expect(rollover({ entries: [entry('2026-01-01', -120, 'ADJUSTMENT')] }).entries).toEqual([])
  })

  it('is a no-op on a second run, because the keys already exist', () => {
    const entries = [entry('2026-01-01', 200, 'LUMP_GRANT')]
    const first = rollover({ entries })
    const second = rollover({ entries: [...entries, ...asExisting(first.entries)] })

    // The balance is unchanged, so a repeated run proposes the same pair — and
    // the unique index on (employee, type, kind, periodKey) rejects both.
    expect(rows(second.entries)).toEqual(rows(first.entries))
    const keys = first.entries.map((e) => `${e.kind}:${e.periodKey}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('runRollover — caps', () => {
  /** 5 days is this employee's days: 2400 at 480/day, 1200 at 240/day. */
  it('resolves an EMPLOYEE_DAYS cap against the employee s own working day', () => {
    expect(applyCap(7200, 'EMPLOYEE_DAYS', 5, { standardMinutesPerDay: 480 })).toBe(2400)
    expect(applyCap(7200, 'EMPLOYEE_DAYS', 5, { standardMinutesPerDay: 240 })).toBe(1200)
  })

  it('carries five of a part-timer s days, not ten', () => {
    const partTimer = employee({ standardMinutesPerDay: 240 })
    const result = rollover({
      employee: partTimer,
      entries: [entry('2026-01-01', 3600, 'LUMP_GRANT')],
      rule: { capBasis: 'EMPLOYEE_DAYS', capValue: 5, carriedExpiresAfterDays: null },
    })

    expect(result.baseCarryMinutes).toBe(1200)
    expect(result.forfeitedMinutes).toBe(2400)
  })

  it('handles a balance under, at and over the cap', () => {
    const cap = { capBasis: 'EMPLOYEE_DAYS', capValue: 5, carriedExpiresAfterDays: null } as const

    const under = rollover({ entries: [entry('2026-01-01', 1000, 'LUMP_GRANT')], rule: cap })
    expect([under.baseCarryMinutes, under.forfeitedMinutes]).toEqual([1000, 0])

    const at = rollover({ entries: [entry('2026-01-01', 2400, 'LUMP_GRANT')], rule: cap })
    expect([at.baseCarryMinutes, at.forfeitedMinutes]).toEqual([2400, 0])

    const over = rollover({ entries: [entry('2026-01-01', 3000, 'LUMP_GRANT')], rule: cap })
    expect([over.baseCarryMinutes, over.forfeitedMinutes]).toEqual([2400, 600])
  })

  it('carries a fixed-minute cap the same for everyone', () => {
    const rule = { capBasis: 'FIXED_MINUTES', capValue: 960, carriedExpiresAfterDays: null } as const
    for (const minutesPerDay of [480, 240]) {
      const result = rollover({
        employee: employee({ standardMinutesPerDay: minutesPerDay }),
        entries: [entry('2026-01-01', 3000, 'LUMP_GRANT')],
        rule,
      })
      expect(result.baseCarryMinutes).toBe(960)
    }
  })

  it('carries nothing under a NONE cap or a missing rule', () => {
    for (const rule of [{ capBasis: 'NONE', capValue: 0, carriedExpiresAfterDays: null } as const, null]) {
      const result = rollover({ entries: [entry('2026-01-01', 3000, 'LUMP_GRANT')], rule })
      expect(result.baseCarryMinutes).toBe(0)
      expect(result.forfeitedMinutes).toBe(3000)
      expect(rows(result.entries)).toEqual(['2027-01-01 -3000 FORFEIT exp=- key=2027-ROLLOVER'])
    }
  })

  /** The type does not survive the boundary at all, whatever the rule says. */
  it('carries nothing for a type with countsTowardRollover = false', () => {
    const result = rollover({
      leaveType: leaveType({ countsTowardRollover: false }),
      rule: { capBasis: 'UNLIMITED', capValue: 0, carriedExpiresAfterDays: null },
      entries: [entry('2026-06-01', 3000, 'COMP_EARNED')],
    })

    expect(result.baseCarryMinutes).toBe(0)
    expect(result.forfeitedMinutes).toBe(3000)
  })

  it('stamps an expiry on carried time when the rule sets one', () => {
    const result = rollover({
      entries: [entry('2026-01-01', 480, 'LUMP_GRANT')],
      rule: { capBasis: 'UNLIMITED', capValue: 0, carriedExpiresAfterDays: 90 },
    })

    expect(iso(result.entries[1].expiresOn!)).toBe('2027-04-01')
  })
})

describe('runRollover — the December comp window', () => {
  /**
   * The church's rule, as one row of configuration: comp does not roll over,
   * except what was earned in December, usable until the end of February.
   */
  const compArgs = {
    leaveType: leaveType({ id: 'comp', countsTowardRollover: false }),
    rule: { capBasis: 'NONE', capValue: 0, carriedExpiresAfterDays: null } as const,
    windows: [carryoverWindow()],
  }

  it('carries comp earned in December and forfeits comp earned in November', () => {
    const entries = [
      entry('2026-11-10', 480, 'COMP_EARNED', { id: 'november' }),
      entry('2026-12-05', 960, 'COMP_EARNED', { id: 'december' }),
    ]
    const result = rollover({ ...compArgs, entries })

    expect(rows(result.entries)).toEqual([
      '2027-01-01 -1440 FORFEIT exp=- key=2027-ROLLOVER',
      '2027-01-01 +960 ROLLOVER_IN exp=2027-02-28 key=2027-ROLLOVER-win',
    ])

    expect(result.windowCarryMinutes).toBe(960)
    expect(result.forfeitedMinutes).toBe(480)
    expect(balanceOf([...entries, ...asExisting(result.entries)], d('2027-01-01'))).toBe(960)
  })

  it('carries only what December actually had left', () => {
    const entries = [
      entry('2026-12-05', 960, 'COMP_EARNED', { id: 'december' }),
      entry('2026-12-20', -480, 'USAGE'),
    ]

    expect(rollover({ ...compArgs, entries }).windowCarryMinutes).toBe(480)
  })

  it('resolves a February 28 window to February 29 in a leap year', () => {
    const result = rollover({
      ...compArgs,
      entries: [entry('2027-12-05', 960, 'COMP_EARNED')],
      closingYear: calendarYear(2027),
      newYear: calendarYear(2028),
    })

    expect(iso(result.entries[1].expiresOn!)).toBe('2028-02-29')
  })

  it('ignores a December lot left over from an earlier year', () => {
    const entries = [entry('2025-12-05', 960, 'COMP_EARNED', { id: 'old-december' })]
    expect(rollover({ ...compArgs, entries }).windowCarryMinutes).toBe(0)
  })

  it('respects a cap on the window itself', () => {
    const result = rollover({
      ...compArgs,
      windows: [carryoverWindow({ capBasis: 'EMPLOYEE_DAYS', capValue: 1 })],
      entries: [entry('2026-12-05', 960, 'COMP_EARNED')],
    })

    expect(result.windowCarryMinutes).toBe(480)
    expect(result.forfeitedMinutes).toBe(480)
  })

  /**
   * A window exists to rescue time the base rule would forfeit, so it never
   * carries more than the closing balance however the two overlap.
   */
  it('never carries more than the closing balance', () => {
    const result = rollover({
      leaveType: leaveType({ id: 'comp' }),
      rule: { capBasis: 'UNLIMITED', capValue: 0, carriedExpiresAfterDays: null },
      windows: [carryoverWindow()],
      entries: [entry('2026-12-05', 960, 'COMP_EARNED')],
    })

    const carried = result.entries
      .filter((e) => e.kind === 'ROLLOVER_IN')
      .reduce((sum, e) => sum + e.minutes, 0)

    expect(carried).toBe(960)
    expect(result.windowCarryMinutes).toBe(0)
  })
})

describe('runRollover — the lump grant for the new year', () => {
  it('grants the new year s allotment alongside the carry', () => {
    const result = rollover({
      entries: [entry('2026-01-01', 7200, 'LUMP_GRANT'), entry('2026-06-01', -4800, 'USAGE')],
      rule: { capBasis: 'EMPLOYEE_DAYS', capValue: 5, carriedExpiresAfterDays: null },
      policy: policy({ annualMinutes: 7200, waitingPeriodDays: 120 }),
    })

    expect(rows(result.entries)).toEqual([
      '2027-01-01 -2400 FORFEIT exp=- key=2027-ROLLOVER',
      '2027-01-01 +2400 ROLLOVER_IN exp=- key=2027-ROLLOVER',
      '2027-01-01 +7200 LUMP_GRANT exp=- key=2027-LUMP',
    ])
  })

  it('grants a new hire with no balance to carry', () => {
    const result = rollover({
      employee: employee({ hireDate: d('2026-11-01') }),
      policy: policy({ annualMinutes: 7200, waitingPeriodDays: 120 }),
    })

    expect(rows(result.entries)).toEqual(['2027-03-01 +7200 LUMP_GRANT exp=- key=2027-LUMP'])
  })
})

describe('runRollover — a non-calendar benefit year', () => {
  it('dates everything on the first day of the July year', () => {
    const result = runRollover({
      employee: employee(),
      leaveType: leaveType(),
      rule: { capBasis: 'EMPLOYEE_DAYS', capValue: 5, carriedExpiresAfterDays: null },
      windows: [],
      policy: policy({ annualMinutes: 7200 }),
      entries: [entry('2026-07-01', 7200, 'LUMP_GRANT')] as ExistingEntry[],
      closingYear: benefitYearStartingIn(2026, 7, 1),
      newYear: benefitYearStartingIn(2027, 7, 1),
    })

    expect(rows(result.entries)).toEqual([
      '2027-07-01 -7200 FORFEIT exp=- key=2027-ROLLOVER',
      '2027-07-01 +2400 ROLLOVER_IN exp=- key=2027-ROLLOVER',
      '2027-07-01 +7200 LUMP_GRANT exp=- key=2027-LUMP',
    ])
  })
})

/**
 * The rollover and the expiry job both run daily and nothing fixes their
 * order. A lot whose `expiresOn` is the old year's last day dies on the very
 * date the rollover is written, so without care the answer depends on which
 * one GitHub happened to run first that morning — and one of the two orders
 * resurrects expired time as a fresh, non-expiring carry.
 */
describe('runRollover — a lot that expires on the last day of the year', () => {
  const expiring = () => [
    entry('2027-01-01', 960, 'ROLLOVER_IN', { id: 'carried', expiresOn: '2027-12-31' }),
  ]

  const closeIt = (entries: ExistingEntry[]) =>
    runRollover({
      employee: employee(),
      leaveType: leaveType(),
      rule: { capBasis: 'UNLIMITED', capValue: 0, carriedExpiresAfterDays: null },
      windows: [],
      policy: null,
      entries,
      closingYear: calendarYear(2027),
      newYear: calendarYear(2028),
    })

  const expire = (entries: ExistingEntry[]) =>
    expireLots({ employee: employee(), leaveTypeId: 'pto', entries, asOf: d('2028-01-01') })

  it('does not carry time that has already expired', () => {
    const result = closeIt(expiring())

    expect(result.baseCarryMinutes).toBe(0)
    expect(result.forfeitedMinutes).toBe(960)
    expect(rows(result.entries)).toEqual(['2028-01-01 -960 FORFEIT exp=- key=2028-ROLLOVER'])
  })

  it('does not forfeit again what an expiry has already taken', () => {
    const withExpiry = [...expiring(), ...asExisting(expire(expiring()))]
    expect(closeIt(withExpiry).entries).toEqual([])
  })

  it('lands on the same balance whichever job runs first', () => {
    const rolloverFirst = (() => {
      let ledger = expiring()
      ledger = [...ledger, ...asExisting(closeIt(ledger).entries)]
      return [...ledger, ...asExisting(expire(ledger))]
    })()

    const expiryFirst = (() => {
      let ledger = expiring()
      ledger = [...ledger, ...asExisting(expire(ledger))]
      return [...ledger, ...asExisting(closeIt(ledger).entries)]
    })()

    expect(balanceOf(rolloverFirst, d('2028-01-01'))).toBe(0)
    expect(balanceOf(expiryFirst, d('2028-01-01'))).toBe(0)
  })
})

/**
 * `usableUntilYearOffset: 0` is permitted by the config schema and resolves to
 * an expiry inside the year that just closed — before the carried entry's own
 * effective date. The ledger's expiry-after-effective CHECK would reject the
 * row and take the rest of the rollover job down with it.
 */
describe('runRollover — a window that expires before the new year', () => {
  it('rescues nothing rather than writing an impossible entry', () => {
    const result = runRollover({
      employee: employee(),
      leaveType: leaveType({ id: 'comp', countsTowardRollover: false }),
      rule: { capBasis: 'NONE', capValue: 0, carriedExpiresAfterDays: null },
      windows: [
        carryoverWindow({
          earnedFromMonth: 1,
          earnedFromDay: 1,
          earnedToMonth: 6,
          earnedToDay: 30,
          usableUntilMonth: 12,
          usableUntilDay: 31,
          usableUntilYearOffset: 0,
        }),
      ],
      policy: null,
      entries: [entry('2026-03-01', 960, 'COMP_EARNED')],
      closingYear: calendarYear(2026),
      newYear: calendarYear(2027),
    })

    expect(result.windowCarryMinutes).toBe(0)
    expect(rows(result.entries)).toEqual(['2027-01-01 -960 FORFEIT exp=- key=2027-ROLLOVER'])

    // Every entry it does write must satisfy the ledger's CHECK constraint.
    for (const e of result.entries) {
      if (e.expiresOn) expect(e.expiresOn.getTime()).toBeGreaterThanOrEqual(e.effectiveDate.getTime())
    }
  })
})
