import { describe, expect, it } from 'vitest'

import { balanceOf, sumOfKind } from '@/lib/accrual/balance'
import { lotBalances } from '@/lib/accrual/lots'

import { d, entry, iso } from './support/accrual'

describe('balanceOf', () => {
  const entries = [
    entry('2026-01-01', 7200, 'LUMP_GRANT'),
    entry('2026-03-10', -480, 'USAGE'),
    entry('2026-07-04', -240, 'USAGE'),
  ]

  it('sums every entry effective on or before the date', () => {
    expect(balanceOf(entries, d('2026-01-01'))).toBe(7200)
    expect(balanceOf(entries, d('2026-03-09'))).toBe(7200)
    expect(balanceOf(entries, d('2026-03-10'))).toBe(6720)
    expect(balanceOf(entries, d('2026-12-31'))).toBe(6480)
  })

  it('is zero before anything was granted', () => {
    expect(balanceOf(entries, d('2025-12-31'))).toBe(0)
    expect(balanceOf([], d('2026-06-01'))).toBe(0)
  })

  it('sums one kind within a range, for the accrual target', () => {
    const mixed = [
      entry('2025-12-31', 100, 'PERIOD_ACCRUAL'),
      entry('2026-01-14', 277, 'PERIOD_ACCRUAL'),
      entry('2026-01-28', 277, 'PERIOD_ACCRUAL'),
      entry('2026-02-01', 480, 'ADJUSTMENT'),
    ]

    expect(sumOfKind(mixed, 'PERIOD_ACCRUAL', { from: d('2026-01-01'), through: d('2026-12-31') })).toBe(554)
  })
})

describe('lotBalances', () => {
  it('turns each positive entry into a lot', () => {
    const { lots } = lotBalances(
      [entry('2026-01-01', 7200, 'LUMP_GRANT'), entry('2026-06-01', 480, 'COMP_EARNED')],
      d('2026-12-31'),
    )

    expect(lots.map((l) => [iso(l.effectiveDate), l.grantedMinutes, l.remainingMinutes])).toEqual([
      ['2026-01-01', 7200, 7200],
      ['2026-06-01', 480, 480],
    ])
  })

  it('ignores entries dated after the as-of date', () => {
    const { lots } = lotBalances(
      [entry('2026-01-01', 480, 'COMP_EARNED'), entry('2026-12-01', 480, 'COMP_EARNED')],
      d('2026-06-30'),
    )

    expect(lots).toHaveLength(1)
  })

  /**
   * Soonest-to-expire first, not FIFO. Strict FIFO would burn permanent PTO
   * while a February-expiring comp lot quietly ran out.
   */
  it('consumes the soonest-expiring lot first, not the oldest', () => {
    const { lots } = lotBalances(
      [
        entry('2026-01-01', 480, 'LUMP_GRANT', { id: 'a-permanent' }),
        entry('2026-02-01', 480, 'ROLLOVER_IN', { id: 'b-expiring', expiresOn: '2026-03-31' }),
        entry('2026-03-01', -480, 'USAGE'),
      ],
      d('2026-12-31'),
    )

    const byId = Object.fromEntries(lots.map((l) => [l.entryId, l.remainingMinutes]))
    expect(byId['b-expiring']).toBe(0)
    expect(byId['a-permanent']).toBe(480)
  })

  it('falls back to the oldest lot when neither expires', () => {
    const { lots } = lotBalances(
      [
        entry('2026-01-01', 480, 'LUMP_GRANT', { id: 'older' }),
        entry('2026-02-01', 480, 'COMP_EARNED', { id: 'newer' }),
        entry('2026-03-01', -240, 'USAGE'),
      ],
      d('2026-12-31'),
    )

    const byId = Object.fromEntries(lots.map((l) => [l.entryId, l.remainingMinutes]))
    expect(byId['older']).toBe(240)
    expect(byId['newer']).toBe(480)
  })

  it('spills across lots when one is not enough', () => {
    const { lots, unappliedMinutes } = lotBalances(
      [
        entry('2026-01-01', 300, 'LUMP_GRANT', { id: 'first' }),
        entry('2026-02-01', 300, 'COMP_EARNED', { id: 'second' }),
        entry('2026-03-01', -500, 'USAGE'),
      ],
      d('2026-12-31'),
    )

    const byId = Object.fromEntries(lots.map((l) => [l.entryId, l.remainingMinutes]))
    expect(byId['first']).toBe(0)
    expect(byId['second']).toBe(100)
    expect(unappliedMinutes).toBe(0)
  })

  it('reports consumption that found no lot', () => {
    const { unappliedMinutes } = lotBalances(
      [entry('2026-01-01', 100, 'LUMP_GRANT'), entry('2026-03-01', -300, 'USAGE')],
      d('2026-12-31'),
    )

    expect(unappliedMinutes).toBe(200)
  })

  it('lets leave taken on the day of a grant draw on that grant', () => {
    const { lots, unappliedMinutes } = lotBalances(
      [entry('2026-01-01', -480, 'USAGE'), entry('2026-01-01', 480, 'LUMP_GRANT')],
      d('2026-12-31'),
    )

    expect(unappliedMinutes).toBe(0)
    expect(lots[0].remainingMinutes).toBe(0)
  })

  /**
   * A rollover writes its FORFEIT and its ROLLOVER_IN on the same day. The
   * forfeit must land on the lots that were already there; if it consumed the
   * fresh carried lot instead, the old balance would survive with no expiry
   * and the December comp lot would never run out.
   */
  it('applies a same-day forfeit to the old lots, not to the carried one', () => {
    const { lots } = lotBalances(
      [
        entry('2026-12-05', 960, 'COMP_EARNED', { id: 'december' }),
        entry('2027-01-01', -960, 'FORFEIT', { id: 'rollover-forfeit' }),
        entry('2027-01-01', 960, 'ROLLOVER_IN', { id: 'carried', expiresOn: '2027-02-28' }),
      ],
      d('2027-01-01'),
    )

    const byId = Object.fromEntries(lots.map((l) => [l.entryId, l.remainingMinutes]))
    expect(byId['december']).toBe(0)
    expect(byId['carried']).toBe(960)
  })

  it('does not let usage draw on a grant that comes later', () => {
    const { unappliedMinutes } = lotBalances(
      [entry('2026-01-01', -480, 'USAGE'), entry('2026-06-01', 480, 'LUMP_GRANT')],
      d('2026-12-31'),
    )

    expect(unappliedMinutes).toBe(480)
  })

  /**
   * The December comp rule in miniature: a balance of 12h after banking 16h in
   * December and spending 8h in January, of which only 8h is the December lot.
   */
  it('answers how much of a particular grant is left', () => {
    const entries = [
      entry('2026-12-15', 960, 'COMP_EARNED', { id: 'december', expiresOn: '2027-02-28' }),
      entry('2027-01-20', -480, 'USAGE'),
      entry('2027-02-10', 240, 'COMP_EARNED', { id: 'february' }),
    ]

    expect(balanceOf(entries, d('2027-02-28'))).toBe(720)

    const byId = Object.fromEntries(
      lotBalances(entries, d('2027-02-28')).lots.map((l) => [l.entryId, l.remainingMinutes]),
    )
    expect(byId['december']).toBe(480)
    expect(byId['february']).toBe(240)
  })

  it('is deterministic when two lots are otherwise identical', () => {
    const build = () => [
      entry('2026-01-01', 300, 'LUMP_GRANT', { id: 'lot-a' }),
      entry('2026-01-01', 300, 'LUMP_GRANT', { id: 'lot-b' }),
      entry('2026-03-01', -300, 'USAGE'),
    ]

    const once = lotBalances(build(), d('2026-12-31')).lots
    const twice = lotBalances(build().reverse(), d('2026-12-31')).lots

    const key = (lots: typeof once) =>
      lots
        .slice()
        .sort((a, b) => (a.entryId < b.entryId ? -1 : 1))
        .map((l) => `${l.entryId}:${l.remainingMinutes}`)

    expect(key(once)).toEqual(key(twice))
    expect(key(once)).toEqual(['lot-a:0', 'lot-b:300'])
  })
})
