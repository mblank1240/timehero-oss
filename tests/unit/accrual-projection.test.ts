import { describe, expect, it } from 'vitest'

import { balanceOf, sumOfKind } from '@/lib/accrual/balance'
import { firstShortfall, projectEntries, type ProjectionArgs } from '@/lib/accrual/projection'
import type { ExistingEntry } from '@/lib/accrual/types'

import { d, employee, entry, iso, leaveType, policy, schedule, window } from './support/accrual'

/**
 * The projection runs the engine forward over a copy of the ledger. These pin
 * that it does what the jobs would do, in the order they would do it, and
 * nothing twice.
 */

const JAN = { month: 1, day: 1 }
const FIVE_DAYS = { capBasis: 'EMPLOYEE_DAYS' as const, capValue: 5, carriedExpiresAfterDays: null }

function args(overrides: Partial<ProjectionArgs>): ProjectionArgs {
  return {
    employee: employee(),
    leaveType: leaveType(),
    policy: policy(),
    rule: FIVE_DAYS,
    windows: [],
    schedule: null,
    benefitYearStart: JAN,
    entries: [],
    from: d('2026-10-07'),
    through: d('2026-10-07'),
    ...overrides,
  }
}

function balance(base: readonly ExistingEntry[], projected: readonly ExistingEntry[], on: string) {
  return balanceOf([...base, ...projected], d(on))
}

describe('projectEntries', () => {
  it('catches up a lump grant that is due but not yet written', () => {
    const projected = projectEntries(args({}))

    expect(projected.map((e) => [iso(e.effectiveDate), e.minutes, e.kind, e.periodKey])).toEqual([
      ['2026-01-01', 7200, 'LUMP_GRANT', '2026-LUMP'],
    ])
  })

  it('projects nothing already written, recognising it by its key', () => {
    const ledger = [{ ...entry('2026-01-01', 7200, 'LUMP_GRANT'), periodKey: '2026-LUMP' }]
    expect(projectEntries(args({ entries: ledger }))).toEqual([])
  })

  it('runs the rollover and the next lump grant across the year boundary', () => {
    const ledger = [{ ...entry('2026-01-01', 7200, 'LUMP_GRANT'), periodKey: '2026-LUMP' }]
    const projected = projectEntries(args({ entries: ledger, through: d('2027-01-02') }))

    // Forfeit the closing 7200, carry five days, grant the new year.
    expect(balance(ledger, projected, '2026-12-31')).toBe(7200)
    expect(balance(ledger, projected, '2027-01-01')).toBe(2400 + 7200)
  })

  /** Why hypothetical usage goes in as entries: the cap applies after spending. */
  it('caps the carry on what is left after the spending', () => {
    const ledger = [
      { ...entry('2026-01-01', 7200, 'LUMP_GRANT'), periodKey: '2026-LUMP' },
      entry('2026-12-14', -6000, 'USAGE'),
    ]
    const projected = projectEntries(args({ entries: ledger, through: d('2027-01-01') }))

    // 1200 left, under the 2400 cap, so all of it carries.
    expect(balance(ledger, projected, '2027-01-01')).toBe(1200 + 7200)
  })

  it('accrues every pay period, summing to exactly the allotment', () => {
    const projected = projectEntries(
      args({
        policy: policy({ method: 'PER_PAY_PERIOD' }),
        schedule: schedule('BIWEEKLY', '2026-01-01'),
        from: d('2026-01-01'),
        through: d('2026-12-31'),
      }),
    )

    expect(projected.every((e) => e.kind === 'PERIOD_ACCRUAL')).toBe(true)
    expect(projected).toHaveLength(26)
    expect(
      sumOfKind(projected, 'PERIOD_ACCRUAL', { from: d('2026-01-01'), through: d('2026-12-31') }),
    ).toBe(7200)
  })

  it('projects no accrual for someone with no policy', () => {
    expect(projectEntries(args({ policy: null, through: d('2027-06-30') }))).toEqual([])
  })

  describe('expiring time', () => {
    // Comp: nothing carries but December, which lasts until the end of February.
    const comp = {
      leaveType: leaveType({ id: 'comp', countsTowardRollover: false }),
      policy: null,
      rule: { capBasis: 'NONE' as const, capValue: 0, carriedExpiresAfterDays: null },
      windows: [window()],
      from: d('2026-12-20'),
    }

    it('carries December comp and forfeits what is left on 1 March', () => {
      const ledger = [entry('2026-12-10', 480, 'COMP_EARNED')]
      const projected = projectEntries(args({ ...comp, entries: ledger, through: d('2027-03-01') }))

      expect(balance(ledger, projected, '2027-02-28')).toBe(480)
      expect(balance(ledger, projected, '2027-03-01')).toBe(0)
    })

    it('reports leave after the expiry as a shortfall, and leave before it as fine', () => {
      const earned = entry('2026-12-10', 480, 'COMP_EARNED')

      const late = [earned, entry('2027-03-05', -480, 'USAGE')]
      const lateAll = [
        ...late,
        ...projectEntries(args({ ...comp, entries: late, through: d('2027-03-05') })),
      ]
      expect(firstShortfall(lateAll, d('2027-03-05'))).toEqual({
        date: d('2027-03-05'),
        balanceMinutes: -480,
      })

      const early = [earned, entry('2027-02-20', -480, 'USAGE')]
      const earlyAll = [
        ...early,
        ...projectEntries(args({ ...comp, entries: early, through: d('2027-03-05') })),
      ]
      expect(firstShortfall(earlyAll, d('2027-02-20'))).toBeNull()
    })
  })
})

describe('firstShortfall', () => {
  it('finds a later booking the earlier one starves', () => {
    const entries = [
      entry('2026-01-01', 480, 'ADJUSTMENT'),
      entry('2026-10-12', -240, 'USAGE'),
      entry('2026-12-01', -480, 'USAGE'),
    ]

    expect(firstShortfall(entries, d('2026-10-12'))).toEqual({
      date: d('2026-12-01'),
      balanceMinutes: -240,
    })
  })

  it('ignores usage before the date it is asked about', () => {
    const entries = [entry('2026-03-01', -480, 'USAGE')]
    expect(firstShortfall(entries, d('2026-04-01'))).toBeNull()
  })

  it('counts a grant landing the same day as the usage', () => {
    const entries = [entry('2026-10-12', 480, 'PERIOD_ACCRUAL'), entry('2026-10-12', -480, 'USAGE')]
    expect(firstShortfall(entries, d('2026-10-12'))).toBeNull()
  })
})
