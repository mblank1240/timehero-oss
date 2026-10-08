import { describe, expect, it } from 'vitest'

import { benefitYearStartingIn, type BenefitYear } from '@/lib/accrual/dates'
import { accruePayPeriod, benefitYearPeriods } from '@/lib/accrual/period'
import type { EmployeeInput, ExistingEntry, PolicyInput } from '@/lib/accrual/types'
import type { PayScheduleInput } from '@/lib/payperiods/generate'

import { asExisting, employee, entry, iso, policy, schedule } from './support/accrual'

const calendarYear = (year: number) => benefitYearStartingIn(year, 1, 1)

/** Biweekly from January 1 2026 — 26 periods close inside the year. */
const BIWEEKLY = schedule('BIWEEKLY', '2026-01-01')

const PER_PERIOD = { method: 'PER_PAY_PERIOD', annualMinutes: 7200 } as const

type RunArgs = {
  employee?: EmployeeInput
  policy?: PolicyInput
  schedule?: PayScheduleInput
  benefitYear?: BenefitYear
  entries?: ExistingEntry[]
}

/**
 * Runs the accrual across every period of a benefit year the way the daily job
 * would, feeding each grant back in so the next period sees it. Returns the
 * grant per period, with nulls for the periods that produce nothing.
 */
function runYear(args: RunArgs = {}) {
  const emp = args.employee ?? employee()
  const pol = args.policy ?? policy(PER_PERIOD)
  const sched = args.schedule ?? BIWEEKLY
  const year = args.benefitYear ?? calendarYear(2026)

  const entries: ExistingEntry[] = [...(args.entries ?? [])]
  const grants: (number | null)[] = []
  const keys: (string | null)[] = []

  for (const period of benefitYearPeriods(sched, year)) {
    const proposed = accruePayPeriod({
      employee: emp,
      policy: pol,
      benefitYear: year,
      schedule: sched,
      period,
      entries,
    })

    grants.push(proposed?.minutes ?? null)
    keys.push(proposed?.periodKey ?? null)
    if (proposed) entries.push(...asExisting([proposed]))
  }

  const granted = grants.filter((g): g is number => g !== null)
  return { grants, keys, entries, total: granted.reduce((a, b) => a + b, 0) }
}

describe('benefitYearPeriods', () => {
  it('assigns a period to the benefit year containing its end date', () => {
    const periods = benefitYearPeriods(BIWEEKLY, calendarYear(2026))

    expect(periods).toHaveLength(26)
    expect([iso(periods[0].startDate), iso(periods[0].endDate)]).toEqual(['2026-01-01', '2026-01-14'])
    expect([iso(periods[25].startDate), iso(periods[25].endDate)]).toEqual(['2026-12-17', '2026-12-30'])

    // The period straddling the boundary belongs to the next year, not both.
    const next = benefitYearPeriods(BIWEEKLY, calendarYear(2027))
    expect([iso(next[0].startDate), iso(next[0].endDate)]).toEqual(['2026-12-31', '2027-01-13'])
  })

  /**
   * A 14-day grid drifts against a 365-day year, so roughly once a decade a
   * calendar year holds 27 period ends. Nothing may round that away.
   */
  it('counts a 27th period in the years that have one', () => {
    const sched = schedule('BIWEEKLY', '2026-01-01')
    const counts = Array.from({ length: 20 }, (_, i) =>
      benefitYearPeriods(sched, calendarYear(2026 + i)).length,
    )

    expect(counts).toContain(27)
    expect(counts.every((n) => n === 26 || n === 27)).toBe(true)
    expect(benefitYearPeriods(sched, calendarYear(2036))).toHaveLength(27)
  })
})

describe('accruePayPeriod — the cumulative target', () => {
  /**
   * The remainder case that silently shorts employees when it is wrong.
   * 7200 / 26 is 276.92: a flat 277 overshoots by 2 minutes over the year and
   * a flat 276 shorts the employee by 24.
   */
  it('sums 26 periods of a 7200-minute allotment to exactly 7200', () => {
    const { grants, total } = runYear()

    expect(grants).toHaveLength(26)
    expect(total).toBe(7200)
    expect(new Set(grants)).toEqual(new Set([277, 276]))
  })

  it('never drifts more than a minute from the straight-line target', () => {
    const { grants } = runYear()

    let running = 0
    grants.forEach((grant, i) => {
      running += grant ?? 0
      expect(Math.abs(running - (7200 * (i + 1)) / 26)).toBeLessThanOrEqual(1)
    })
  })

  it('numbers the periods from the start of the benefit year', () => {
    const { keys } = runYear()
    expect(keys[0]).toBe('2026-PP01')
    expect(keys[6]).toBe('2026-PP07')
    expect(keys[25]).toBe('2026-PP26')
  })

  /** A re-run has nothing to add, so the job is safe to repeat. */
  it('grants nothing on a second run of the same period', () => {
    const first = runYear()
    const period = benefitYearPeriods(BIWEEKLY, calendarYear(2026))[25]

    expect(
      accruePayPeriod({
        employee: employee(),
        policy: policy(PER_PERIOD),
        benefitYear: calendarYear(2026),
        schedule: BIWEEKLY,
        period,
        entries: first.entries,
      }),
    ).toBeNull()
  })

  /**
   * The self-correcting property: a job that fails to run is caught up by the
   * next one, because the target does not care how it was reached.
   */
  it('catches up a skipped period on the next run', () => {
    const periods = benefitYearPeriods(BIWEEKLY, calendarYear(2026))
    const entries: ExistingEntry[] = []
    const grants: number[] = []

    periods.slice(0, 5).forEach((period, i) => {
      // The third period's job never runs.
      if (i === 2) return

      const proposed = accruePayPeriod({
        employee: employee(),
        policy: policy(PER_PERIOD),
        benefitYear: calendarYear(2026),
        schedule: BIWEEKLY,
        period,
        entries,
      })
      grants.push(proposed!.minutes)
      entries.push(...asExisting([proposed!]))
    })

    // Periods 1, 2, 4, 5 — the fourth run covers the gap.
    expect(grants).toEqual([277, 277, 554, 277])
    expect(grants.reduce((a, b) => a + b, 0)).toBe(Math.round((7200 * 5) / 26))
  })

  it('still reaches exactly the allotment after a skipped period', () => {
    const periods = benefitYearPeriods(BIWEEKLY, calendarYear(2026))
    const entries: ExistingEntry[] = []

    periods.forEach((period, i) => {
      if (i === 2 || i === 17) return
      const proposed = accruePayPeriod({
        employee: employee(),
        policy: policy(PER_PERIOD),
        benefitYear: calendarYear(2026),
        schedule: BIWEEKLY,
        period,
        entries,
      })
      if (proposed) entries.push(...asExisting([proposed]))
    })

    expect(entries.reduce((sum, e) => sum + e.minutes, 0)).toBe(7200)
  })

  /**
   * A 27-period year deliberately pays 27/26 of the allotment rather than
   * rounding the extra period away — see `periodsPerYear`.
   */
  it('pays 27/26 of the allotment in a 27-period year', () => {
    const sched = schedule('BIWEEKLY', '2026-01-01')
    const year = calendarYear(2036)
    expect(benefitYearPeriods(sched, year)).toHaveLength(27)

    const { grants, total } = runYear({ schedule: sched, benefitYear: year })
    expect(grants).toHaveLength(27)
    expect(total).toBe(Math.round((7200 * 27) / 26))
  })
})

describe('accruePayPeriod — eligibility', () => {
  /**
   * A new hire whose waiting period ends in period 10 must not be handed
   * 10/26 of the year in one grant. The allotment spreads across the periods
   * they are eligible for and still lands on exactly the allotment.
   */
  it('spreads a full first-year allotment across the periods that remain', () => {
    const hire = employee({ hireDate: new Date(Date.UTC(2026, 2, 1)) })
    const { grants, total } = runYear({
      employee: hire,
      policy: policy({ ...PER_PERIOD, waitingPeriodDays: 120 }),
    })

    // Eligibility is June 29. The 12th period closes on June 17, the 13th on
    // July 1, so the 13th is the first one accrued.
    expect(grants.slice(0, 12).every((g) => g === null)).toBe(true)
    expect(grants[12]).not.toBeNull()
    expect(total).toBe(7200)
    // No single grant is a windfall covering the whole waiting period.
    expect(Math.max(...grants.map((g) => g ?? 0))).toBeLessThan(600)
  })

  it('prorates a deferred first year when the policy says to', () => {
    const hire = employee({ hireDate: new Date(Date.UTC(2026, 2, 1)) })
    const { total } = runYear({
      employee: hire,
      policy: policy({ ...PER_PERIOD, waitingPeriodDays: 120, firstYearGrant: 'PRORATE' }),
    })

    expect(total).toBe(3669)
  })

  it('grants nothing at all when the first year is NONE', () => {
    const hire = employee({ hireDate: new Date(Date.UTC(2026, 2, 1)) })
    const { total, grants } = runYear({
      employee: hire,
      policy: policy({ ...PER_PERIOD, waitingPeriodDays: 120, firstYearGrant: 'NONE' }),
    })

    expect(total).toBe(0)
    expect(grants.every((g) => g === null)).toBe(true)
  })

  /** A terminated employee accrues nothing after their termination date. */
  it('stops accruing at the termination date', () => {
    const leaver = employee({ terminationDate: new Date(Date.UTC(2026, 5, 30)) })
    const { grants, total } = runYear({ employee: leaver })

    // June 30 falls inside the 13th period (June 18 - July 1), which closes
    // after they leave, so the 12th is the last one accrued.
    expect(grants.slice(0, 12).every((g) => g !== null)).toBe(true)
    expect(grants.slice(12).every((g) => g === null)).toBe(true)
    expect(total).toBe(Math.round((7200 * 12) / 26))
  })

  it('ignores an annual-lump policy', () => {
    const period = benefitYearPeriods(BIWEEKLY, calendarYear(2026))[0]
    expect(
      accruePayPeriod({
        employee: employee(),
        policy: policy({ method: 'ANNUAL_LUMP' }),
        benefitYear: calendarYear(2026),
        schedule: BIWEEKLY,
        period,
        entries: [],
      }),
    ).toBeNull()
  })

  it('ignores a period belonging to another benefit year', () => {
    const period = benefitYearPeriods(BIWEEKLY, calendarYear(2027))[0]
    expect(
      accruePayPeriod({
        employee: employee(),
        policy: policy(PER_PERIOD),
        benefitYear: calendarYear(2026),
        schedule: BIWEEKLY,
        period,
        entries: [],
      }),
    ).toBeNull()
  })
})

describe('accruePayPeriod — the balance ceiling', () => {
  /**
   * `maxBalanceMinutes` pauses accrual while the balance sits at or above it,
   * and accrual resumes once the balance drops — bounded by the headroom that
   * opened, so the pause never becomes a windfall.
   */
  it('stops at the ceiling and resumes after the balance drops', () => {
    const capped = policy({ ...PER_PERIOD, maxBalanceMinutes: 1000 })
    const periods = benefitYearPeriods(BIWEEKLY, calendarYear(2026))
    const entries: ExistingEntry[] = []
    const grants: (number | null)[] = []

    periods.slice(0, 8).forEach((period, i) => {
      // After five periods the employee takes a day off, freeing headroom.
      if (i === 5) entries.push(entry('2026-03-10', -480, 'USAGE'))

      const proposed = accruePayPeriod({
        employee: employee(),
        policy: capped,
        benefitYear: calendarYear(2026),
        schedule: BIWEEKLY,
        period,
        entries,
      })
      grants.push(proposed?.minutes ?? null)
      if (proposed) entries.push(...asExisting([proposed]))
    })

    // 277 x 3 = 831, then the fourth grant is trimmed to the 169 of headroom
    // left under 1000, and the fifth is refused outright.
    expect(grants.slice(0, 5)).toEqual([277, 277, 277, 169, null])

    // The day off drops the balance to 520, so accrual resumes.
    expect(grants[5]).toBeGreaterThan(0)
    expect(grants.slice(5).some((g) => (g ?? 0) > 0)).toBe(true)

    // And never pushes the balance past the ceiling.
    const balance = entries.reduce((sum, e) => sum + e.minutes, 0)
    expect(balance).toBeLessThanOrEqual(1000)
  })

  it('leaves accrual alone when there is no ceiling', () => {
    expect(runYear().total).toBe(7200)
  })
})

describe('accruePayPeriod — a non-calendar benefit year', () => {
  it('accrues a July-to-June year in full', () => {
    const sched = schedule('BIWEEKLY', '2026-07-02')
    const year = benefitYearStartingIn(2026, 7, 1)
    const { grants, total } = runYear({ schedule: sched, benefitYear: year })

    expect(grants.length).toBeGreaterThanOrEqual(26)
    expect(total).toBe(Math.round((7200 * grants.length) / 26))
  })
})
