import { describe, expect, it } from 'vitest'

import { benefitYearStartingIn } from '@/lib/accrual/dates'
import { benefitYearPeriods, settleBenefitYear } from '@/lib/accrual/period'
import { runRollover } from '@/lib/accrual/rollover'
import type { ExistingEntry } from '@/lib/accrual/types'
import { missedRollover } from '@/lib/jobs/health'

import { asExisting, d, employee, entry, iso, leaveType, policy, rows, schedule } from './support/accrual'

/**
 * A benefit year whose last pay day was missed, and the rollover that has to
 * notice. Figures are the 7200-minute allotment over a biweekly year from
 * 1 January 2026: 26 periods, the n-th ending on 1 January + 14n − 1, so the
 * last ends on 30 December.
 */

const Y2026 = benefitYearStartingIn(2026, 1, 1)
const Y2027 = benefitYearStartingIn(2027, 1, 1)
const BIWEEKLY = schedule('BIWEEKLY', '2026-01-01')
const PER_PERIOD = policy({ method: 'PER_PAY_PERIOD', annualMinutes: 7200 })
const FIVE_DAYS = { capBasis: 'EMPLOYEE_DAYS' as const, capValue: 5, carriedExpiresAfterDays: null }

/**
 * The PERIOD_ACCRUAL rows the daily job would have written for the first
 * `count` periods: round(7200 × n / 26) cumulatively, so each is the
 * difference between successive targets.
 */
function accruedThrough(count: number): ExistingEntry[] {
  const periods = benefitYearPeriods(BIWEEKLY, Y2026)
  const out: ExistingEntry[] = []
  let granted = 0
  for (let n = 1; n <= count; n += 1) {
    const target = Math.round((7200 * n) / 26)
    out.push({
      ...entry(iso(periods[n - 1].endDate), target - granted, 'PERIOD_ACCRUAL'),
      periodKey: `2026-PP${String(n).padStart(2, '0')}`,
    })
    granted = target
  }
  return out
}

const settle = (entries: ExistingEntry[]) =>
  settleBenefitYear({
    employee: employee(),
    policy: PER_PERIOD,
    benefitYear: Y2026,
    schedule: BIWEEKLY,
    entries,
  })

describe('settleBenefitYear', () => {
  it('has the year end on 30 December, in period 26', () => {
    const periods = benefitYearPeriods(BIWEEKLY, Y2026)
    expect(periods).toHaveLength(26)
    expect(iso(periods[25].endDate)).toBe('2026-12-30')
  })

  it('settles a missed last pay day: 7200 − round(7200 × 25/26) = 7200 − 6923 = 277', () => {
    const ledger = accruedThrough(25)
    expect(ledger.reduce((sum, e) => sum + e.minutes, 0)).toBe(6923)

    const result = settle(ledger)
    expect(result.status).toBe('settled')
    if (result.status !== 'settled') return
    expect(rows([result.entry])).toEqual(['2026-12-30 +277 PERIOD_ACCRUAL exp=- key=2026-PP26'])
  })

  it('settles every period the year is short, not just the last: 7200 − 6646 = 554', () => {
    // round(7200 × 24/26) = round(6646.15) = 6646
    const result = settle(accruedThrough(24))
    expect(result.status === 'settled' && result.entry.minutes).toBe(554)
  })

  it('has nothing to do for a year accrued in full', () => {
    expect(settle(accruedThrough(26))).toEqual({ status: 'complete' })
  })

  it('is idempotent: the settlement fed back in settles nothing more', () => {
    const ledger = accruedThrough(25)
    const first = settle(ledger)
    if (first.status !== 'settled') throw new Error('expected a settlement')
    expect(settle([...ledger, ...asExisting([first.entry])])).toEqual({ status: 'complete' })
  })

  /**
   * An install that went live after the year ended has nothing dated in it.
   * The formula would hand everyone the whole 7200 into a closed year — which
   * the rollover would then partly carry — so it is reported instead.
   */
  it('reports, and does not write, a year the ledger never reached', () => {
    const opening = [entry('2027-03-15', 3000, 'ADJUSTMENT')]
    expect(settle(opening)).toEqual({ status: 'untracked', minutes: 7200 })
  })

  it('settles nothing for someone who left before the year ended', () => {
    const leaver = employee({ terminationDate: d('2026-11-30') })
    const result = settleBenefitYear({
      employee: leaver,
      policy: PER_PERIOD,
      benefitYear: Y2026,
      schedule: BIWEEKLY,
      entries: accruedThrough(23),
    })
    expect(result).toEqual({ status: 'complete' })
  })

  /**
   * Why the settlement has to come before the rollover rather than after it.
   * 25 periods accrued (6923) and 2400 spent: the closing balance is 4523
   * without the last period and 4800 with it. Five days (2400) carries
   * either way, so the net loss is 2123 or 2400 — and a 277 written after
   * the first rollover is 277 minutes that escape the cap for good.
   */
  it('lets the rollover forfeit the settled accrual along with the rest', () => {
    const ledger = [...accruedThrough(25), entry('2026-07-01', -2400, 'USAGE')]
    const settlement = settle(ledger)
    if (settlement.status !== 'settled') throw new Error('expected a settlement')

    const close = (entries: ExistingEntry[]) =>
      runRollover({
        employee: employee(),
        leaveType: leaveType(),
        rule: FIVE_DAYS,
        windows: [],
        policy: null,
        entries,
        closingYear: Y2026,
        newYear: Y2027,
      })

    const without = close(ledger)
    expect(without.closingBalanceMinutes).toBe(4523)
    expect(rows(without.entries)).toEqual([
      '2027-01-01 -4523 FORFEIT exp=- key=2027-ROLLOVER',
      '2027-01-01 +2400 ROLLOVER_IN exp=- key=2027-ROLLOVER',
    ])

    const settled = close([...ledger, ...asExisting([settlement.entry])])
    expect(settled.closingBalanceMinutes).toBe(4800)
    expect(rows(settled.entries)).toEqual([
      '2027-01-01 -4800 FORFEIT exp=- key=2027-ROLLOVER',
      '2027-01-01 +2400 ROLLOVER_IN exp=- key=2027-ROLLOVER',
    ])
  })
})

describe('missedRollover', () => {
  const yearStart = d('2027-01-01')

  it('allows the first day, when the run may simply not have fired yet', () => {
    expect(missedRollover({ today: d('2027-01-01'), yearStart, rolledOver: false })).toBe(false)
  })

  it('alarms from the second day of a year with no rollover', () => {
    expect(missedRollover({ today: d('2027-01-02'), yearStart, rolledOver: false })).toBe(true)
    expect(missedRollover({ today: d('2027-08-15'), yearStart, rolledOver: false })).toBe(true)
  })

  it('is quiet once the year has been rolled over, however late', () => {
    expect(missedRollover({ today: d('2027-08-15'), yearStart, rolledOver: true })).toBe(false)
  })
})
