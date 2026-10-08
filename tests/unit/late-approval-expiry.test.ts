import { describe, expect, it } from 'vitest'

import { benefitYearStartingIn } from '@/lib/accrual/dates'
import { planCompEarned, type CompPlanArgs } from '@/lib/accrual/comp'
import { expireLots } from '@/lib/accrual/expiry'
import { firstShortfall, projectEntries } from '@/lib/accrual/projection'
import type { ExistingEntry } from '@/lib/accrual/types'

import { d, employee, entry, iso, leaveType, window as carryoverWindow } from './support/accrual'

/**
 * Time that runs out while someone is waiting on an approval: a leave request
 * against a comp lot that expires before the last signature, and overtime
 * whose comp would already have expired by the time it is approved.
 */

const JAN = { month: 1, day: 1 }

describe('firstShortfall — a lot that expired while the request was pending', () => {
  /**
   * 480 of comp earned 1 March, expiring 31 March. A request for 30 March is
   * submitted on 20 March; the expiry job forfeits the unspent 480 on
   * 1 April; the request is approved on 2 April.
   */
  const lot = entry('2027-03-01', 480, 'COMP_EARNED', { expiresOn: '2027-03-31' })
  const request = entry('2027-03-30', -480, 'USAGE')

  it('is what the expiry job writes on 1 April, knowing nothing of the request', () => {
    const forfeits = expireLots({
      employee: employee(),
      leaveTypeId: 'comp',
      entries: [lot],
      asOf: d('2027-04-01'),
    })
    expect(forfeits.map((f) => [iso(f.effectiveDate), f.minutes])).toEqual([['2027-04-01', -480]])
  })

  it('finds the double charge on the day of the forfeit, not the day of the leave', () => {
    const forfeit = { ...entry('2027-04-01', -480, 'FORFEIT'), periodKey: `${lot.id}-EXPIRY` }
    const ledger = [lot, forfeit, request]

    // On 30 March itself the balance is a healthy 480 − 480 = 0 — the only
    // date a usage-day check looked at.
    expect(firstShortfall(ledger, d('2027-03-30'))).toEqual({
      // 480 − 480 spent − 480 forfeited
      date: d('2027-04-01'),
      balanceMinutes: -480,
    })
  })

  it('finds it through the projection the approval runs, from today on', () => {
    const forfeit = { ...entry('2027-04-01', -480, 'FORFEIT'), periodKey: `${lot.id}-EXPIRY` }
    const ledger: ExistingEntry[] = [lot, forfeit, request]
    const projected = projectEntries({
      employee: employee(),
      leaveType: leaveType({ id: 'comp', countsTowardRollover: false }),
      policy: null,
      rule: null,
      windows: [],
      schedule: null,
      benefitYearStart: JAN,
      entries: ledger,
      from: d('2027-04-02'),
      through: d('2027-04-02'),
    })

    expect(firstShortfall([...ledger, ...projected], d('2027-03-30'))?.balanceMinutes).toBe(-480)
  })

  it('passes the same request approved before the expiry job runs', () => {
    // Approved on 31 March: the lot is spent first, so 1 April forfeits nothing.
    const ledger = [lot, request]
    const projected = projectEntries({
      employee: employee(),
      leaveType: leaveType({ id: 'comp', countsTowardRollover: false }),
      policy: null,
      rule: null,
      windows: [],
      schedule: null,
      benefitYearStart: JAN,
      entries: ledger,
      from: d('2027-03-31'),
      through: d('2027-04-01'),
    })

    expect(projected).toEqual([])
    expect(firstShortfall([...ledger, ...projected], d('2027-03-30'))).toBeNull()
  })

  it('passes a half-spent lot whose remainder expired on time', () => {
    // 480 − 240 spent = 240 left; 1 April forfeits exactly that, to zero.
    const ledger = [
      lot,
      entry('2027-03-30', -240, 'USAGE'),
      { ...entry('2027-04-01', -240, 'FORFEIT'), periodKey: `${lot.id}-EXPIRY` },
    ]
    expect(firstShortfall(ledger, d('2027-03-30'))).toBeNull()
  })
})

describe('planCompEarned — comp that expired before it was approved', () => {
  const Y2026 = benefitYearStartingIn(2026, 1, 1)
  const Y2027 = benefitYearStartingIn(2027, 1, 1)

  function args(overrides: Partial<CompPlanArgs> & { date: string }): CompPlanArgs {
    const { date, ...rest } = overrides
    return {
      log: { id: 'log1', employeeId: 'emp', date: d(date), minutes: 240 },
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

  it('flags a 30-day expiry that passed before approval: 1 March + 30 = 31 March', () => {
    const plan = planCompEarned(
      args({ date: '2027-03-01', expiresAfterDays: 30, today: d('2027-04-15') }),
    )
    expect(plan.expiredOn).toEqual(d('2027-03-31'))
    expect(plan.explanation).toMatch(/expired on 2027-03-31/)
  })

  it('does not flag it on the expiry date itself, when the time is still spendable', () => {
    const plan = planCompEarned(
      args({ date: '2027-03-01', expiresAfterDays: 30, today: d('2027-03-31') }),
    )
    expect(plan.expiredOn).toBeNull()
    expect(plan.explanation).toBeNull()
  })

  it('flags December overtime approved after the window’s 28 February', () => {
    const late = planCompEarned(args({ date: '2026-12-20', today: d('2027-03-01') }))
    expect(late.expiredOn).toEqual(d('2027-02-28'))

    const onTime = planCompEarned(args({ date: '2026-12-20', today: d('2027-02-28') }))
    expect(onTime.expiredOn).toBeNull()
    expect(onTime.earnedMinutes).toBe(240)
  })

  it('never flags comp with no expiry, however late', () => {
    expect(planCompEarned(args({ date: '2027-01-05', today: d('2027-12-31') })).expiredOn).toBeNull()
  })

  it('says nothing about expiry when not told the date', () => {
    expect(planCompEarned(args({ date: '2027-03-01', expiresAfterDays: 30 })).expiredOn).toBeNull()
  })
})
