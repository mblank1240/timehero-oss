import { describe, expect, it } from 'vitest'

import { projectEntries, type ProjectionArgs } from '@/lib/accrual/projection'
import { bookedAfter, nextAccrual, nextLoss } from '@/lib/dashboard/summary'

import { d, employee, entry, iso, leaveType, policy } from './support/accrual'

/**
 * The dashboard reads its "next accrual" and "will be forfeited" lines off the
 * engine's own projection. Most of these run the real `projectEntries()`, so
 * they pin what an employee would actually be told, not just how the rows are
 * picked.
 */

const JAN = { month: 1, day: 1 }
const FIVE_DAYS = { capBasis: 'EMPLOYEE_DAYS' as const, capValue: 5, carriedExpiresAfterDays: null }
const ELEVEN_DAYS = 11 * 480

function project(overrides: Partial<ProjectionArgs>) {
  return projectEntries({
    employee: employee(),
    leaveType: leaveType(),
    policy: policy({ annualMinutes: ELEVEN_DAYS }),
    rule: FIVE_DAYS,
    windows: [],
    schedule: null,
    benefitYearStart: JAN,
    entries: [],
    from: d('2026-10-07'),
    through: d('2027-10-06'),
    ...overrides,
  })
}

const granted = { ...entry('2026-01-01', ELEVEN_DAYS, 'LUMP_GRANT'), periodKey: '2026-LUMP' }

describe('nextAccrual', () => {
  it("is next year's lump grant once this year's is written", () => {
    const projected = project({ entries: [granted] })
    const next = nextAccrual(projected, d('2026-10-07'))

    expect(next && [iso(next.date), next.minutes]).toEqual(['2027-01-01', ELEVEN_DAYS])
  })

  it('skips a grant due today, which today’s balance already counts', () => {
    const today = d('2026-01-01')
    const projected = project({ from: today, through: d('2026-12-31') })

    // The projection does write today's grant…
    expect(projected.some((e) => e.kind === 'LUMP_GRANT' && iso(e.effectiveDate) === '2026-01-01')).toBe(true)
    // …but it is not the *next* one, and there is none later this year.
    expect(nextAccrual(projected, today)).toBeNull()
  })

  it('is null for someone with no policy', () => {
    expect(nextAccrual(project({ policy: null, entries: [granted] }), d('2026-10-07'))).toBeNull()
  })

  it('does not count carried time as an accrual', () => {
    const projected = [entry('2027-01-01', 960, 'ROLLOVER_IN'), entry('2027-01-15', 200, 'PERIOD_ACCRUAL')]
    const next = nextAccrual(projected, d('2026-10-07'))
    expect(next && iso(next.date)).toBe('2027-01-15')
  })
})

describe('nextLoss', () => {
  it('reports what a capped rollover forfeits, net of approved leave still to come', () => {
    // 11 days granted, 2.5 taken, 3 booked for November: 5.5 days at the end
    // of the year against a 5-day cap. Half a day is lost.
    const ledger = [
      granted,
      entry('2026-02-16', -1200, 'USAGE'),
      entry('2026-11-23', -1440, 'USAGE'),
    ]
    const loss = nextLoss(project({ entries: ledger }), d('2026-10-07'))

    expect(loss && [iso(loss.date), iso(loss.usableThrough), loss.minutes]).toEqual([
      '2027-01-01',
      '2026-12-31',
      240,
    ])
  })

  it('is null when the rollover carries everything', () => {
    const ledger = [granted, entry('2026-03-01', -ELEVEN_DAYS + 960, 'USAGE')]
    expect(nextLoss(project({ entries: ledger }), d('2026-10-07'))).toBeNull()
  })

  it('reports the whole balance for a type that does not roll over at all', () => {
    const loss = nextLoss(
      project({ entries: [granted], leaveType: leaveType({ countsTowardRollover: false }) }),
      d('2026-10-07'),
    )
    expect(loss?.minutes).toBe(ELEVEN_DAYS)
  })

  it('reports carried time expiring, dated the day after its last usable day', () => {
    const carried = entry('2027-01-01', 480, 'ROLLOVER_IN', { expiresOn: '2027-02-28' })
    const today = d('2027-01-10')
    const loss = nextLoss(
      project({ policy: null, entries: [carried], from: today, through: d('2028-01-09') }),
      today,
    )

    expect(loss && [iso(loss.date), iso(loss.usableThrough), loss.minutes]).toEqual([
      '2027-03-01',
      '2027-02-28',
      480,
    ])
  })

  it('ignores a forfeit dated today, which is already past its last usable day', () => {
    const projected = [entry('2027-01-01', -500, 'FORFEIT'), entry('2027-01-01', 200, 'ROLLOVER_IN')]
    expect(nextLoss(projected, d('2027-01-01'))).toBeNull()
    expect(nextLoss(projected, d('2026-12-31'))?.minutes).toBe(300)
  })
})

describe('bookedAfter', () => {
  it('counts approved leave after today, net of reversals, and nothing already taken', () => {
    const ledger = [
      entry('2026-10-01', -480, 'USAGE'),
      entry('2026-10-07', -480, 'USAGE'),
      entry('2026-11-02', -480, 'USAGE'),
      entry('2026-11-03', -240, 'USAGE'),
      entry('2026-11-03', 240, 'USAGE_REVERSAL'),
      entry('2026-12-01', 480, 'ADJUSTMENT'),
    ]
    expect(bookedAfter(ledger, d('2026-10-07'))).toBe(480)
  })
})
