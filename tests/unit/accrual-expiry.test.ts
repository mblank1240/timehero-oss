import { describe, expect, it } from 'vitest'

import { balanceOf } from '@/lib/accrual/balance'
import { benefitYearStartingIn } from '@/lib/accrual/dates'
import { expireLots } from '@/lib/accrual/expiry'
import { lotBalances } from '@/lib/accrual/lots'
import { runRollover } from '@/lib/accrual/rollover'
import type { ExistingEntry } from '@/lib/accrual/types'

import {
  asExisting,
  d,
  employee,
  entry,
  iso,
  leaveType,
  rows,
  window as carryoverWindow,
} from './support/accrual'

const calendarYear = (year: number) => benefitYearStartingIn(year, 1, 1)

function expire(entries: ExistingEntry[], asOf: string) {
  return expireLots({ employee: employee(), leaveTypeId: 'comp', entries, asOf: d(asOf) })
}

describe('expireLots', () => {
  const carried = [entry('2027-01-01', 960, 'ROLLOVER_IN', { id: 'dec', expiresOn: '2027-02-28' })]

  it('leaves a lot alone before and on its expiry date', () => {
    expect(expire(carried, '2027-02-27')).toEqual([])
    expect(expire(carried, '2027-02-28')).toEqual([])
  })

  it('forfeits the remainder the day after it expires', () => {
    expect(rows(expire(carried, '2027-03-01'))).toEqual([
      '2027-03-01 -960 FORFEIT exp=- key=dec-EXPIRY',
    ])
  })

  it('dates the forfeit from the expiry, not from when the job ran', () => {
    const late = expire(carried, '2027-03-20')
    expect(iso(late[0].effectiveDate)).toBe('2027-03-01')
  })

  it('never expires a lot without an expiry date', () => {
    expect(expire([entry('2026-01-01', 7200, 'LUMP_GRANT')], '2030-01-01')).toEqual([])
  })

  it('writes nothing for a lot that was fully spent', () => {
    const spent = [...carried, entry('2027-02-01', -960, 'USAGE')]
    expect(expire(spent, '2027-03-01')).toEqual([])
  })

  it('keys the forfeit to the lot, so a re-run adds nothing', () => {
    const first = expire(carried, '2027-03-01')
    const second = expire([...carried, ...asExisting(first)], '2027-03-01')

    expect(second).toEqual([])
    expect(first[0].periodKey).toBe('dec-EXPIRY')
    expect(first[0].sourceId).toBe('dec')
  })

  it('expires each lot separately', () => {
    const two = [
      entry('2027-01-01', 480, 'ROLLOVER_IN', { id: 'first', expiresOn: '2027-02-28' }),
      entry('2027-01-01', 240, 'ROLLOVER_IN', { id: 'second', expiresOn: '2027-06-30' }),
    ]

    expect(expire(two, '2027-03-01').map((e) => e.periodKey)).toEqual(['first-EXPIRY'])
    expect(expire(two, '2027-07-01').map((e) => e.periodKey)).toEqual([
      'first-EXPIRY',
      'second-EXPIRY',
    ])
  })
})

/**
 * The church's comp-time rule end to end, as the jobs would run it: earned in
 * December, carried on January 1, spent in January, and whatever is left
 * forfeited on March 1.
 */
describe('the December comp grace period, end to end', () => {
  const compType = leaveType({ id: 'comp', countsTowardRollover: false })
  const compRule = { capBasis: 'NONE', capValue: 0, carriedExpiresAfterDays: null } as const

  function closeTheYear(entries: ExistingEntry[]) {
    const result = runRollover({
      employee: employee(),
      leaveType: compType,
      rule: compRule,
      windows: [carryoverWindow()],
      policy: null,
      entries,
      closingYear: calendarYear(2026),
      newYear: calendarYear(2027),
    })
    return [...entries, ...asExisting(result.entries)]
  }

  it('carries December comp into the new year and expires it on March 1', () => {
    let ledger = closeTheYear([
      entry('2026-11-10', 480, 'COMP_EARNED'),
      entry('2026-12-05', 960, 'COMP_EARNED'),
    ])

    // November is gone, December survives.
    expect(balanceOf(ledger, d('2027-01-01'))).toBe(960)

    // Nothing to expire while the grace period runs.
    expect(expire(ledger, '2027-02-28')).toEqual([])

    ledger = [...ledger, ...asExisting(expire(ledger, '2027-03-01'))]
    expect(balanceOf(ledger, d('2027-03-01'))).toBe(0)
  })

  /** The forfeit is exactly what went unspent, not the whole carried amount. */
  it('forfeits exactly what went unspent', () => {
    let ledger = closeTheYear([entry('2026-12-05', 960, 'COMP_EARNED')])
    ledger = [...ledger, entry('2027-01-20', -480, 'USAGE')]

    const forfeits = expire(ledger, '2027-03-01')
    expect(forfeits).toHaveLength(1)
    expect(forfeits[0].minutes).toBe(-480)

    ledger = [...ledger, ...asExisting(forfeits)]
    expect(balanceOf(ledger, d('2027-03-01'))).toBe(0)
  })

  /**
   * Consumption order is what makes this work: comp spent in January draws on
   * the December lot that is about to expire, not on comp earned in January
   * that never will.
   */
  it('spends the December lot before comp earned in January', () => {
    let ledger = closeTheYear([entry('2026-12-05', 960, 'COMP_EARNED')])
    ledger = [
      ...ledger,
      entry('2027-01-15', 480, 'COMP_EARNED', { id: 'january' }),
      entry('2027-01-20', -480, 'USAGE'),
    ]

    const byId = Object.fromEntries(
      lotBalances(ledger, d('2027-02-28')).lots.map((l) => [l.entryId, l.remainingMinutes]),
    )
    // The January lot is untouched; the December carry took the hit.
    expect(byId['january']).toBe(480)

    ledger = [...ledger, ...asExisting(expire(ledger, '2027-03-01'))]
    // 960 earned in December, 480 spent, 480 forfeited — and January's 480
    // survives, which strict FIFO would have burned instead.
    expect(balanceOf(ledger, d('2027-03-01'))).toBe(480)
  })
})
