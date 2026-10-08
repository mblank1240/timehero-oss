import { describe, expect, it } from 'vitest'

import { benefitYearStartingIn } from '@/lib/accrual/dates'
import { OPENING_PERIOD_KEY, planOpeningBalance, type OpeningBalanceArgs } from '@/lib/accrual/opening'
import { accruePayPeriod, benefitYearPeriods } from '@/lib/accrual/period'
import { grantLump } from '@/lib/accrual/grant'

import { asExisting, d, employee, entry, policy, rows, schedule } from './support/accrual'

const year2026 = benefitYearStartingIn(2026, 1, 1)

function plan(overrides: Partial<OpeningBalanceArgs> = {}) {
  return planOpeningBalance({
    employee: employee(),
    leaveTypeId: 'pto',
    policy: policy({ annualMinutes: 5280 }),
    benefitYear: year2026,
    asOf: d('2026-11-30'),
    openingMinutes: 1440,
    entries: [],
    note: 'Opening balance as of 2026-11-30',
    ...overrides,
  })
}

function planned(result: ReturnType<typeof plan>) {
  if (result.status !== 'planned') throw new Error(`expected a plan, got ${result.status}`)
  return result
}

describe('planOpeningBalance — annual lump', () => {
  /**
   * 11 days granted on January 1, 3 days left at cutover: the grant is
   * written as the job would have written it, and the adjustment takes
   * away the 8 days the old system says were used.
   */
  it('writes this year’s grant and adjusts down to the real balance', () => {
    const result = planned(plan())
    expect(rows(result.grants)).toEqual(['2026-01-01 +5280 LUMP_GRANT exp=- key=2026-LUMP'])
    expect(rows([result.adjustment])).toEqual([
      `2026-11-30 -3840 ADJUSTMENT exp=- key=${OPENING_PERIOD_KEY}`,
    ])
    expect(result.adjustment.note).toBe('Opening balance as of 2026-11-30')
  })

  /** The point of the whole design: the job has nothing left to grant. */
  it('leaves the accrual job nothing to add', () => {
    const result = planned(plan())
    const ledger = asExisting([...result.grants, result.adjustment])
    const again = grantLump(employee(), policy({ annualMinutes: 5280 }), year2026)
    expect(ledger.some((e) => e.kind === again?.kind && e.periodKey === again?.periodKey)).toBe(true)
  })

  it('adjusts upward when the employee carried time in', () => {
    const result = planned(plan({ openingMinutes: 7680 }))
    expect(result.adjustment.minutes).toBe(2400)
  })

  it('posts a zero adjustment when the grant already equals the balance', () => {
    // Still written: it is the record of the import, and its key refuses a second.
    expect(planned(plan({ openingMinutes: 5280 })).adjustment.minutes).toBe(0)
  })

  it('writes no grant still inside its waiting period at cutover', () => {
    const result = planned(
      plan({
        employee: employee({ hireDate: d('2026-10-01') }),
        policy: policy({ annualMinutes: 5280, waitingPeriodDays: 120 }),
        openingMinutes: 0,
      }),
    )
    expect(result.grants).toEqual([])
    expect(result.adjustment.minutes).toBe(0)
  })

  it('does not write a grant the job already wrote, and counts it', () => {
    const existing = asExisting([grantLump(employee(), policy({ annualMinutes: 5280 }), year2026)!])
    const result = planned(plan({ entries: existing }))
    expect(result.grants).toEqual([])
    expect(result.adjustment.minutes).toBe(1440 - 5280)
  })

  it('ignores entries dated after the cutover when working out the difference', () => {
    const result = planned(plan({ entries: [entry('2026-12-15', -480, 'USAGE')] }))
    expect(result.adjustment.minutes).toBe(1440 - 5280)
  })

  it('refuses to import the same balance twice', () => {
    const first = planned(plan())
    const ledger = asExisting([...first.grants, first.adjustment])
    expect(plan({ entries: ledger, openingMinutes: 999 })).toEqual({ status: 'already-imported' })
  })
})

describe('planOpeningBalance — no policy', () => {
  it('posts the whole balance as the adjustment, with any expiry', () => {
    const result = planned(
      plan({ leaveTypeId: 'comp', policy: null, openingMinutes: 960, expiresOn: d('2027-02-28') }),
    )
    expect(result.grants).toEqual([])
    expect(rows([result.adjustment])).toEqual([
      `2026-11-30 +960 ADJUSTMENT exp=2027-02-28 key=${OPENING_PERIOD_KEY}`,
    ])
  })
})

describe('planOpeningBalance — per pay period', () => {
  const biweekly = schedule('BIWEEKLY', '2026-01-04')
  const perPeriod = policy({ method: 'PER_PAY_PERIOD', annualMinutes: 5200 })
  const periods = benefitYearPeriods(biweekly, year2026)

  it('writes every period accrual due by the cutover, then lets the job continue', () => {
    const asOf = periods[9].endDate
    const result = planned(
      plan({ policy: perPeriod, schedule: biweekly, periods, asOf, openingMinutes: 1000 }),
    )

    expect(result.grants).toHaveLength(10)
    expect(result.grants.every((g) => g.kind === 'PERIOD_ACCRUAL')).toBe(true)
    expect(result.grants.reduce((sum, g) => sum + g.minutes, 0)).toBe(2000)
    expect(result.adjustment.minutes).toBe(-1000)

    // The eleventh period is one period's worth, not a catch-up.
    const next = accruePayPeriod({
      employee: employee(),
      policy: perPeriod,
      benefitYear: year2026,
      schedule: biweekly,
      period: periods[10],
      entries: asExisting([...result.grants, result.adjustment]),
    })
    expect(next?.minutes).toBe(200)
  })
})
