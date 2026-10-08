import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db } from '@/lib/db'
import { runAccrual as accrue } from '@/lib/jobs/accrue'
import { runExpireLots as expire } from '@/lib/jobs/expire'
import { runBenefitYearRollover as rollover } from '@/lib/jobs/rollover'
import { runJob } from '@/lib/jobs/runner'
import { balanceAsOf } from '@/lib/ledger/balance'

/**
 * The whole Phase 3 pipeline against real Postgres: the jobs, the ledger, and
 * the constraints the database enforces on its own.
 *
 * The unit suite proves the engine computes the right numbers. This proves the
 * numbers survive the round trip — that the unique index really does make a
 * re-run a no-op, that the append-only trigger really does refuse an update,
 * and that a year of accrual and rollover lands on the figures a spreadsheet
 * would give.
 *
 * Everything is namespaced by a run id and torn down afterwards, so it can run
 * against a seeded development database without disturbing it.
 */

const RUN = `itest-${Date.now().toString(36)}`
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

/** A standard 8-hour day, matching the seed's default. */
const DAY = 480
const ANNUAL = 7200

let leaveTypeId: string
let compTypeId: string
let policyId: string
let veteranId: string
let novemberHireId: string
let hourlyId: string

/**
 * Ledger rows and job runs that existed before this file ran.
 *
 * The jobs under test are org-wide: `runAccrual` and `runBenefitYearRollover`
 * write grants for every seeded employee, not only the ones created here. The
 * ledger is append-only by trigger, so a developer who runs this against their
 * seeded development database cannot undo those rows through the app. Taking a
 * snapshot and deleting whatever is new afterwards is what makes the file's
 * promise — that it disturbs nothing — actually true.
 */
/**
 * The jobs, run the way production runs them: inside a `JobRun`, so the
 * entries they write carry its id.
 */
const runAccrual = (asOf: Date) => runJob({ jobName: 'accrue-pay-period' }, (run) => accrue(asOf, run))
const runBenefitYearRollover = (asOf: Date) =>
  runJob({ jobName: 'benefit-year-rollover' }, (run) => rollover(asOf, run))
const runExpireLots = (asOf: Date) => runJob({ jobName: 'expire-lots' }, (run) => expire(asOf, run))

let preexistingEntryIds: string[] = []
let preexistingJobRunIds: string[] = []

beforeAll(async () => {
  preexistingEntryIds = (await db.ledgerEntry.findMany({ select: { id: true } })).map((r) => r.id)
  preexistingJobRunIds = (await db.jobRun.findMany({ select: { id: true } })).map((r) => r.id)

  const org = await db.orgSettings.findUnique({ where: { id: 1 } })
  if (!org) throw new Error('Run `npm run db:seed` before the integration tests.')
  // Everything below is hand-calculated against a January benefit year.
  expect([org.benefitYearStartMonth, org.benefitYearStartDay]).toEqual([1, 1])

  const leaveType = await db.leaveType.create({
    data: { code: `${RUN}-PTO`, name: `${RUN} PTO`, countsTowardRollover: true },
  })
  leaveTypeId = leaveType.id

  await db.rolloverRule.create({
    // Five of the employee's own days: 2400 minutes at 480/day.
    data: { leaveTypeId, capBasis: 'EMPLOYEE_DAYS', capValue: 5 },
  })

  const compType = await db.leaveType.create({
    data: {
      code: `${RUN}-COMP`,
      name: `${RUN} Comp`,
      countsTowardRollover: false,
      accruableBy: 'EXEMPT_ONLY',
    },
  })
  compTypeId = compType.id

  await db.rolloverRule.create({
    data: { leaveTypeId: compTypeId, capBasis: 'NONE', capValue: 0 },
  })

  await db.carryoverWindow.create({
    data: {
      name: `${RUN} December grace`,
      leaveTypeId: compTypeId,
      earnedFromMonth: 12,
      earnedFromDay: 1,
      earnedToMonth: 12,
      earnedToDay: 31,
      usableUntilMonth: 2,
      usableUntilDay: 28,
      usableUntilYearOffset: 1,
      capBasis: 'UNLIMITED',
    },
  })

  const policy = await db.leavePolicy.create({
    data: {
      name: `${RUN} Standard`,
      leaveTypeId,
      method: 'ANNUAL_LUMP',
      annualMinutes: ANNUAL,
      waitingPeriodDays: 120,
      firstYearGrant: 'FULL_AFTER_WAITING',
    },
  })
  policyId = policy.id

  const people = [
    { key: 'veteran', hireDate: d('2015-01-01'), employmentType: 'SALARIED_EXEMPT' as const },
    { key: 'november', hireDate: d('2026-11-01'), employmentType: 'SALARIED_EXEMPT' as const },
    { key: 'hourly', hireDate: d('2015-01-01'), employmentType: 'HOURLY' as const },
  ]

  const created: Record<string, string> = {}
  for (const person of people) {
    const employee = await db.employee.create({
      data: {
        email: `${RUN}-${person.key}@example.test`,
        firstName: RUN,
        lastName: person.key,
        employmentType: person.employmentType,
        hireDate: person.hireDate,
        standardMinutesPerDay: DAY,
      },
    })
    created[person.key] = employee.id

    await db.employeeLeavePolicy.create({
      data: { employeeId: employee.id, leavePolicyId: policyId, effectiveFrom: person.hireDate },
    })
  }

  veteranId = created.veteran
  novemberHireId = created.november
  hourlyId = created.hourly
})

afterAll(async () => {
  const employeeIds = [veteranId, novemberHireId, hourlyId].filter(Boolean)

  // Every ledger row written while this file ran, whoever it belongs to —
  // including the grants the org-wide jobs wrote for seeded employees. Ledger
  // rows go first: a leave type is onDelete Restrict and cannot be removed
  // while entries still point at it.
  await db.ledgerEntry.deleteMany({ where: { id: { notIn: preexistingEntryIds } } })
  await db.jobRun.deleteMany({ where: { id: { notIn: preexistingJobRunIds } } })

  await db.employeeLeavePolicy.deleteMany({ where: { employeeId: { in: employeeIds } } })
  await db.employee.deleteMany({ where: { id: { in: employeeIds } } })
  await db.leavePolicy.deleteMany({ where: { id: policyId } })
  await db.carryoverWindow.deleteMany({ where: { leaveTypeId: compTypeId } })
  await db.rolloverRule.deleteMany({ where: { leaveTypeId: { in: [leaveTypeId, compTypeId] } } })
  await db.leaveType.deleteMany({ where: { id: { in: [leaveTypeId, compTypeId] } } })
})

async function entriesFor(employeeId: string, typeId = leaveTypeId) {
  return db.ledgerEntry.findMany({
    where: { employeeId, leaveTypeId: typeId },
    orderBy: [{ effectiveDate: 'asc' }, { id: 'asc' }],
    select: { effectiveDate: true, minutes: true, kind: true, periodKey: true, expiresOn: true },
  })
}

const iso = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null)

describe('the accrual job', () => {
  it('grants the established employee their allotment on day one of the year', async () => {
    await runAccrual(d('2026-01-01'))

    const entries = await entriesFor(veteranId)
    expect(entries).toHaveLength(1)
    expect([iso(entries[0].effectiveDate), entries[0].minutes, entries[0].kind]).toEqual([
      '2026-01-01',
      ANNUAL,
      'LUMP_GRANT',
    ])
    expect(entries[0].periodKey).toBe('2026-LUMP')
  })

  /** The guarantee the whole design rests on: a retry grants nothing twice. */
  it('writes nothing on a second run of the same date', async () => {
    const before = await db.ledgerEntry.count()
    const result = await runAccrual(d('2026-01-01'))
    const after = await db.ledgerEntry.count()

    // An identical second call, so nothing anywhere is owed anything new.
    expect(result.entriesCreated).toBe(0)
    expect(after).toBe(before)
    expect(await entriesFor(veteranId)).toHaveLength(1)
  })

  /** What Phase 10's "reverse this run" will query by. */
  it('stamps every entry it writes with the run that wrote it', async () => {
    const first = await db.jobRun.findFirst({
      where: { jobName: 'accrue-pay-period', id: { notIn: preexistingJobRunIds } },
      orderBy: { startedAt: 'asc' },
      select: { id: true, entriesCreated: true, _count: { select: { ledgerEntries: true } } },
    })
    expect(first?._count.ledgerEntries).toBe(first?.entriesCreated)

    const grant = await db.ledgerEntry.findFirstOrThrow({
      where: { employeeId: veteranId, leaveTypeId },
      select: { jobRunId: true },
    })
    expect(grant.jobRunId).toBe(first?.id)
  })

  it('grants nothing to someone not yet hired', async () => {
    expect(await entriesFor(novemberHireId)).toHaveLength(0)
  })

  it('balances by summing the ledger, as of a date', async () => {
    expect(await balanceAsOf(veteranId, leaveTypeId, d('2025-12-31'))).toBe(0)
    expect(await balanceAsOf(veteranId, leaveTypeId, d('2026-01-01'))).toBe(ANNUAL)
  })
})

describe('the rollover job', () => {
  beforeAll(async () => {
    // Four weeks taken in June, leaving 2400 — exactly the five-day cap.
    await db.ledgerEntry.create({
      data: {
        employeeId: veteranId,
        leaveTypeId,
        effectiveDate: d('2026-06-01'),
        minutes: -4800,
        kind: 'USAGE',
      },
    })
  })

  it('does nothing on a day that is not the benefit year start', async () => {
    const result = await runBenefitYearRollover(d('2026-06-15'))
    expect(result.entriesCreated).toBe(0)
    expect(result.detail?.skipped).toBe('not the benefit year start')
  })

  /**
   * 7200 granted, 4800 spent, 2400 closing — which is exactly the five-day
   * cap, so all of it carries. The forfeit and the re-grant net to zero and
   * the new allotment lands on top: 2400 + 7200 = 9600.
   */
  it('forfeits the closing balance and re-grants the carry, without doubling it', async () => {
    expect(await balanceAsOf(veteranId, leaveTypeId, d('2026-12-31'))).toBe(2400)

    await runBenefitYearRollover(d('2027-01-01'))

    const entries = await entriesFor(veteranId)
    expect(
      entries.map((e) => [iso(e.effectiveDate), e.minutes, e.kind, e.periodKey]),
    ).toEqual([
      ['2026-01-01', 7200, 'LUMP_GRANT', '2026-LUMP'],
      ['2026-06-01', -4800, 'USAGE', null],
      ['2027-01-01', -2400, 'FORFEIT', '2027-ROLLOVER'],
      ['2027-01-01', 2400, 'ROLLOVER_IN', '2027-ROLLOVER'],
      ['2027-01-01', 7200, 'LUMP_GRANT', '2027-LUMP'],
    ])

    expect(await balanceAsOf(veteranId, leaveTypeId, d('2027-01-01'))).toBe(9600)
  })

  it('is a no-op when re-run for the same year', async () => {
    const result = await runBenefitYearRollover(d('2027-01-01'))
    expect(result.entriesCreated).toBe(0)
    expect(await balanceAsOf(veteranId, leaveTypeId, d('2027-01-01'))).toBe(9600)
  })

  /**
   * November 1 plus 120 days is March 1 of the following year. The hire year
   * produces nothing, and the next year's single grant is dated March 1 — not
   * January 1, and not twice.
   */
  it('gives the November hire nothing until March, then one grant', async () => {
    const entries = await entriesFor(novemberHireId)

    expect(entries.map((e) => [iso(e.effectiveDate), e.minutes, e.periodKey])).toEqual([
      ['2027-03-01', ANNUAL, '2027-LUMP'],
    ])

    expect(await balanceAsOf(novemberHireId, leaveTypeId, d('2027-01-01'))).toBe(0)
    expect(await balanceAsOf(novemberHireId, leaveTypeId, d('2027-02-28'))).toBe(0)
    expect(await balanceAsOf(novemberHireId, leaveTypeId, d('2027-03-01'))).toBe(ANNUAL)
  })

  it('caps the carry at five of the employee s own days', async () => {
    // Give them more than the cap and close another year.
    await db.ledgerEntry.create({
      data: {
        employeeId: veteranId,
        leaveTypeId,
        effectiveDate: d('2027-06-01'),
        minutes: 1200,
        kind: 'ADJUSTMENT',
        note: 'Integration test: push the balance over the cap',
      },
    })

    expect(await balanceAsOf(veteranId, leaveTypeId, d('2027-12-31'))).toBe(10_800)

    await runBenefitYearRollover(d('2028-01-01'))

    // 10800 closing, 2400 carried, 8400 forfeited, plus the new allotment.
    expect(await balanceAsOf(veteranId, leaveTypeId, d('2028-01-01'))).toBe(2400 + ANNUAL)
  })
})

describe('the December comp window and lot expiry', () => {
  it('carries December comp, expires it on March 1, and keeps January comp', async () => {
    // Comp is earned from approved overtime, not granted by a policy.
    await db.ledgerEntry.createMany({
      data: [
        {
          employeeId: veteranId,
          leaveTypeId: compTypeId,
          effectiveDate: d('2029-11-10'),
          minutes: 480,
          kind: 'COMP_EARNED',
        },
        {
          employeeId: veteranId,
          leaveTypeId: compTypeId,
          effectiveDate: d('2029-12-05'),
          minutes: 960,
          kind: 'COMP_EARNED',
        },
      ],
    })

    await runBenefitYearRollover(d('2030-01-01'))

    // November's 480 is gone; December's 960 survives with an expiry.
    const carried = await entriesFor(veteranId, compTypeId)
    const rolloverIn = carried.find((e) => e.kind === 'ROLLOVER_IN')
    expect(rolloverIn?.minutes).toBe(960)
    expect(iso(rolloverIn?.expiresOn ?? null)).toBe('2030-02-28')
    expect(await balanceAsOf(veteranId, compTypeId, d('2030-01-01'))).toBe(960)

    // Half of it is spent in January, and comp earned in January is not.
    await db.ledgerEntry.createMany({
      data: [
        {
          employeeId: veteranId,
          leaveTypeId: compTypeId,
          effectiveDate: d('2030-01-15'),
          minutes: 240,
          kind: 'COMP_EARNED',
        },
        {
          employeeId: veteranId,
          leaveTypeId: compTypeId,
          effectiveDate: d('2030-01-20'),
          minutes: -480,
          kind: 'USAGE',
        },
      ],
    })

    // Nothing expires while the grace period is still running. Asserted on
    // this employee's own balance rather than the job's total, which counts
    // every account in the database.
    await runExpireLots(d('2030-02-28'))
    expect(await balanceAsOf(veteranId, compTypeId, d('2030-02-28'))).toBe(720)

    await runExpireLots(d('2030-03-01'))

    const forfeit = (await entriesFor(veteranId, compTypeId)).find(
      (e) => e.kind === 'FORFEIT' && iso(e.effectiveDate) === '2030-03-01',
    )
    // 960 carried, 480 spent, so exactly 480 goes unspent.
    expect(forfeit?.minutes).toBe(-480)

    // The January 240 survives — strict FIFO would have burned it instead.
    expect(await balanceAsOf(veteranId, compTypeId, d('2030-03-01'))).toBe(240)
  })

  it('expires each lot once, however often the job runs', async () => {
    const before = await balanceAsOf(veteranId, compTypeId, d('2030-03-01'))
    await runExpireLots(d('2030-03-01'))
    await runExpireLots(d('2030-03-01'))
    expect(await balanceAsOf(veteranId, compTypeId, d('2030-03-01'))).toBe(before)
  })
})

/**
 * The invariants the database enforces on its own. They are in the migration
 * rather than only in the service layer so they hold for a console session, a
 * future caller, and anything written by hand.
 */
describe('ledger constraints', () => {
  it('refuses a second entry under the same idempotency key', async () => {
    await expect(
      db.ledgerEntry.create({
        data: {
          employeeId: veteranId,
          leaveTypeId,
          effectiveDate: d('2026-01-01'),
          minutes: ANNUAL,
          kind: 'LUMP_GRANT',
          periodKey: '2026-LUMP',
        },
      }),
    ).rejects.toThrow()
  })

  it('allows repeated manual entries, which carry no key', async () => {
    const make = () =>
      db.ledgerEntry.create({
        data: {
          employeeId: veteranId,
          leaveTypeId,
          effectiveDate: d('2026-02-01'),
          minutes: 60,
          kind: 'ADJUSTMENT',
          note: 'Integration test: two corrections on one day',
        },
      })

    const first = await make()
    const second = await make()
    expect(first.id).not.toBe(second.id)
  })

  it('refuses an ADJUSTMENT with no reason', async () => {
    await expect(
      db.ledgerEntry.create({
        data: {
          employeeId: veteranId,
          leaveTypeId,
          effectiveDate: d('2026-03-01'),
          minutes: 60,
          kind: 'ADJUSTMENT',
          note: '   ',
        },
      }),
    ).rejects.toThrow()
  })

  it('refuses a positive FORFEIT', async () => {
    await expect(
      db.ledgerEntry.create({
        data: {
          employeeId: veteranId,
          leaveTypeId,
          effectiveDate: d('2026-03-01'),
          minutes: 60,
          kind: 'FORFEIT',
        },
      }),
    ).rejects.toThrow()
  })

  it('refuses an expiry date before the grant it belongs to', async () => {
    await expect(
      db.ledgerEntry.create({
        data: {
          employeeId: veteranId,
          leaveTypeId,
          effectiveDate: d('2026-03-01'),
          minutes: 60,
          kind: 'ROLLOVER_IN',
          expiresOn: d('2026-02-01'),
        },
      }),
    ).rejects.toThrow()
  })

  /**
   * Rule 4. The FLSA bars private employers from giving non-exempt staff comp
   * time in lieu of overtime pay, so this is a wage-and-hour liability rather
   * than a bug — and it holds whatever route the write came in by.
   */
  it('refuses COMP_EARNED for an hourly employee', async () => {
    await expect(
      db.ledgerEntry.create({
        data: {
          employeeId: hourlyId,
          leaveTypeId: compTypeId,
          effectiveDate: d('2026-03-01'),
          minutes: 60,
          kind: 'COMP_EARNED',
        },
      }),
    ).rejects.toThrow(/SALARIED_EXEMPT/)
  })

  it('allows COMP_EARNED for an exempt employee', async () => {
    const entry = await db.ledgerEntry.create({
      data: {
        employeeId: veteranId,
        leaveTypeId: compTypeId,
        effectiveDate: d('2026-03-01'),
        minutes: 60,
        kind: 'COMP_EARNED',
      },
    })
    expect(entry.minutes).toBe(60)
  })

  /** Rule 2: a correction is a new entry, never an edit. */
  it('refuses to update an existing entry', async () => {
    const entry = await db.ledgerEntry.findFirstOrThrow({ where: { employeeId: veteranId } })

    await expect(
      db.ledgerEntry.update({ where: { id: entry.id }, data: { minutes: 1 } }),
    ).rejects.toThrow(/append-only/)
  })
})
