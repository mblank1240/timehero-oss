import { describe, expect, it } from 'vitest'

import { benefitYearStartingIn } from '@/lib/accrual/dates'
import { eligibilityDate, entitlementForYear, grantLump } from '@/lib/accrual/grant'

import { employee, iso, policy } from './support/accrual'

const calendarYear = (year: number) => benefitYearStartingIn(year, 1, 1)

/** The church's rule: the whole allotment, 120 days after the start date. */
const CHURCH_PTO = { annualMinutes: 7200, waitingPeriodDays: 120 } as const

describe('grantLump — an established employee', () => {
  it('grants the full allotment on the first day of the benefit year', () => {
    const grant = grantLump(
      employee({ hireDate: new Date(Date.UTC(2015, 4, 3)) }),
      policy(CHURCH_PTO),
      calendarYear(2026),
    )

    expect(grant).not.toBeNull()
    expect(iso(grant!.effectiveDate)).toBe('2026-01-01')
    expect(grant!.minutes).toBe(7200)
    expect(grant!.kind).toBe('LUMP_GRANT')
    expect(grant!.periodKey).toBe('2026-LUMP')
  })

  it('ignores firstYearGrant once the waiting period is long past', () => {
    for (const firstYearGrant of ['FULL_AFTER_WAITING', 'PRORATE', 'NONE'] as const) {
      const grant = grantLump(employee(), policy({ ...CHURCH_PTO, firstYearGrant }), calendarYear(2026))
      expect(grant?.minutes).toBe(7200)
      expect(iso(grant!.effectiveDate)).toBe('2026-01-01')
    }
  })
})

describe('grantLump — the waiting period', () => {
  /**
   * March 1 + 120 days is June 29. The grant is dated then, and January 1
   * produces nothing, because there is one grant per year and its date is
   * `max(yearStart, hireDate + waitingPeriodDays)`.
   */
  it('dates a March 1 hire on June 29 and grants nothing on January 1', () => {
    const grant = grantLump(
      employee({ hireDate: new Date(Date.UTC(2026, 2, 1)) }),
      policy(CHURCH_PTO),
      calendarYear(2026),
    )

    expect(iso(grant!.effectiveDate)).toBe('2026-06-29')
    expect(grant!.minutes).toBe(7200)
  })

  /**
   * The bug the one-formula rule exists to prevent. A November 1 hire's
   * waiting period ends the following March, so the hire year produces nothing
   * and the next year's single grant is dated March 1 — not January 1, and not
   * twice.
   */
  it('gives a November 1 hire nothing in the hire year and one March 1 grant in the next', () => {
    const hire = employee({ hireDate: new Date(Date.UTC(2026, 10, 1)) })
    const pto = policy(CHURCH_PTO)

    expect(grantLump(hire, pto, calendarYear(2026))).toBeNull()

    const next = grantLump(hire, pto, calendarYear(2027))
    expect(iso(next!.effectiveDate)).toBe('2027-03-01')
    expect(next!.minutes).toBe(7200)
    expect(next!.periodKey).toBe('2027-LUMP')

    // And the year after that is an ordinary January 1 grant, not a second
    // March one.
    expect(iso(grantLump(hire, pto, calendarYear(2028))!.effectiveDate)).toBe('2028-01-01')
  })

  it('computes the eligibility date the same way for both accrual methods', () => {
    const hire = employee({ hireDate: new Date(Date.UTC(2026, 2, 1)) })
    const lump = eligibilityDate(hire, policy(CHURCH_PTO), calendarYear(2026))
    const perPeriod = eligibilityDate(
      hire,
      policy({ ...CHURCH_PTO, method: 'PER_PAY_PERIOD' }),
      calendarYear(2026),
    )

    expect(iso(lump)).toBe('2026-06-29')
    expect(iso(perPeriod)).toBe('2026-06-29')
  })

  it('grants nothing to someone who leaves before their waiting period ends', () => {
    const leaver = employee({
      hireDate: new Date(Date.UTC(2026, 2, 1)),
      terminationDate: new Date(Date.UTC(2026, 4, 15)),
    })

    expect(grantLump(leaver, policy(CHURCH_PTO), calendarYear(2026))).toBeNull()
    expect(grantLump(leaver, policy(CHURCH_PTO), calendarYear(2027))).toBeNull()
  })

  it('grants someone who leaves on the day their waiting period ends', () => {
    const leaver = employee({
      hireDate: new Date(Date.UTC(2026, 2, 1)),
      terminationDate: new Date(Date.UTC(2026, 5, 29)),
    })

    expect(grantLump(leaver, policy(CHURCH_PTO), calendarYear(2026))?.minutes).toBe(7200)
  })
})

describe('grantLump — firstYearGrant modes', () => {
  const marchHire = employee({ hireDate: new Date(Date.UTC(2026, 2, 1)) })

  it('FULL_AFTER_WAITING gives the whole allotment', () => {
    const grant = grantLump(marchHire, policy({ ...CHURCH_PTO, firstYearGrant: 'FULL_AFTER_WAITING' }), calendarYear(2026))
    expect(grant!.minutes).toBe(7200)
  })

  /**
   * June 29 to December 31 inclusive is 186 of 2026's 365 days, so
   * round(7200 x 186 / 365) = 3669.
   */
  it('PRORATE gives a share of the remaining year', () => {
    const grant = grantLump(marchHire, policy({ ...CHURCH_PTO, firstYearGrant: 'PRORATE' }), calendarYear(2026))
    expect(iso(grant!.effectiveDate)).toBe('2026-06-29')
    expect(grant!.minutes).toBe(Math.round((7200 * 186) / 365))
    expect(grant!.minutes).toBe(3669)
  })

  it('NONE gives nothing until the next benefit year', () => {
    const none = policy({ ...CHURCH_PTO, firstYearGrant: 'NONE' })
    expect(grantLump(marchHire, none, calendarYear(2026))).toBeNull()
    expect(grantLump(marchHire, none, calendarYear(2027))!.minutes).toBe(7200)
  })

  /** A mid-year hire with no waiting period is still a deferred first year. */
  it('prorates a mid-year hire with no waiting period', () => {
    const julyHire = employee({ hireDate: new Date(Date.UTC(2026, 6, 1)) })
    const prorated = policy({ annualMinutes: 7200, waitingPeriodDays: 0, firstYearGrant: 'PRORATE' })

    const grant = grantLump(julyHire, prorated, calendarYear(2026))
    expect(iso(grant!.effectiveDate)).toBe('2026-07-01')
    // July 1 to December 31 is 184 days.
    expect(grant!.minutes).toBe(Math.round((7200 * 184) / 365))

    const full = grantLump(julyHire, policy({ ...prorated, firstYearGrant: 'FULL_AFTER_WAITING' }), calendarYear(2026))
    expect(full!.minutes).toBe(7200)
  })
})

describe('grantLump — other guards', () => {
  it('grants nothing for a year before the employee was hired', () => {
    const future = employee({ hireDate: new Date(Date.UTC(2027, 3, 1)) })
    expect(grantLump(future, policy(CHURCH_PTO), calendarYear(2026))).toBeNull()
  })

  it('ignores a per-pay-period policy', () => {
    expect(grantLump(employee(), policy({ method: 'PER_PAY_PERIOD' }), calendarYear(2026))).toBeNull()
  })

  it('grants nothing when the allotment is zero', () => {
    expect(grantLump(employee(), policy({ annualMinutes: 0 }), calendarYear(2026))).toBeNull()
  })

  /** A July benefit year shifts the grant date with it. */
  it('follows a non-calendar benefit year', () => {
    const grant = grantLump(employee(), policy(CHURCH_PTO), benefitYearStartingIn(2026, 7, 1))
    expect(iso(grant!.effectiveDate)).toBe('2026-07-01')
    expect(grant!.periodKey).toBe('2026-LUMP')
  })

  it('reports whether eligibility was deferred', () => {
    expect(entitlementForYear(employee(), policy(CHURCH_PTO), calendarYear(2026))?.deferred).toBe(false)
    expect(
      entitlementForYear(
        employee({ hireDate: new Date(Date.UTC(2026, 2, 1)) }),
        policy(CHURCH_PTO),
        calendarYear(2026),
      )?.deferred,
    ).toBe(true)
  })
})
