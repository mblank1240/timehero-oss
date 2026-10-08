import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { addDays } from '@/lib/accrual/dates'
import { db } from '@/lib/db'
import { runBenefitYearRollover as rollover } from '@/lib/jobs/rollover'
import { runJob } from '@/lib/jobs/runner'
import { balanceAsOf } from '@/lib/ledger/balance'

/**
 * A rollover whose day was missed, and a year whose last pay day was missed
 * with it, against real Postgres.
 *
 * Hand-checked figures: 7200 minutes a year over a biweekly schedule anchored
 * on 1 January 2034, so 26 periods close in 2034, the n-th on
 * 1 January + 14n − 1 and the last on 30 December. Twenty-five were accrued
 * (round(7200 × 25/26) = 6923) and 2400 spent. The 30 December run never
 * happened, and neither did the one on 1 January 2035.
 *
 * A far-off year keeps clear of anything else in the database. The job is
 * org-wide, so every row it writes is removed afterwards, like the ledger
 * suite.
 */

const RUN = `rctest-${Date.now().toString(36)}`
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const iso = (date: Date) => date.toISOString().slice(0, 10)

const DAY = 480
const ANNUAL = 7200

let leaveTypeId: string
let scheduleId: string
let policyId: string
let employeeId: string
let preexistingEntryIds: string[] = []
let preexistingJobRunIds: string[] = []

const runRollover = (asOf: Date) =>
  runJob({ jobName: 'benefit-year-rollover' }, (run) => rollover(asOf, run))

beforeAll(async () => {
  preexistingEntryIds = (await db.ledgerEntry.findMany({ select: { id: true } })).map((r) => r.id)
  preexistingJobRunIds = (await db.jobRun.findMany({ select: { id: true } })).map((r) => r.id)

  const org = await db.orgSettings.findUnique({ where: { id: 1 } })
  if (!org) throw new Error('Run `npm run db:seed` before the integration tests.')
  expect([org.benefitYearStartMonth, org.benefitYearStartDay]).toEqual([1, 1])

  const type = await db.leaveType.create({
    data: {
      code: `${RUN}-PTO`,
      name: `${RUN} PTO`,
      countsTowardRollover: true,
      // Five of the employee's own days: 2400 at 480/day.
      rolloverRule: { create: { capBasis: 'EMPLOYEE_DAYS', capValue: 5 } },
    },
  })
  leaveTypeId = type.id

  const schedule = await db.paySchedule.create({
    data: { name: RUN, type: 'BIWEEKLY', anchorDate: d('2034-01-01'), payDateOffsetDays: 3 },
  })
  scheduleId = schedule.id

  const policy = await db.leavePolicy.create({
    data: {
      name: `${RUN} Per period`,
      leaveTypeId,
      method: 'PER_PAY_PERIOD',
      annualMinutes: ANNUAL,
      waitingPeriodDays: 0,
      firstYearGrant: 'FULL_AFTER_WAITING',
    },
  })
  policyId = policy.id

  const employee = await db.employee.create({
    data: {
      email: `${RUN}@example.test`,
      firstName: RUN,
      lastName: 'per-period',
      employmentType: 'SALARIED_EXEMPT',
      hireDate: d('2020-01-01'),
      standardMinutesPerDay: DAY,
      payScheduleId: scheduleId,
    },
  })
  employeeId = employee.id

  await db.employeeLeavePolicy.create({
    data: { employeeId, leavePolicyId: policyId, effectiveFrom: d('2020-01-01') },
  })

  // Periods 1–25, as the daily job would have written them.
  let granted = 0
  const accruals = []
  for (let n = 1; n <= 25; n += 1) {
    const target = Math.round((ANNUAL * n) / 26)
    accruals.push({
      employeeId,
      leaveTypeId,
      effectiveDate: addDays(d('2034-01-01'), 14 * n - 1),
      minutes: target - granted,
      kind: 'PERIOD_ACCRUAL' as const,
      periodKey: `2034-PP${String(n).padStart(2, '0')}`,
    })
    granted = target
  }
  await db.ledgerEntry.createMany({
    data: [
      ...accruals,
      { employeeId, leaveTypeId, effectiveDate: d('2034-07-03'), minutes: -2400, kind: 'USAGE' },
    ],
  })
})

afterAll(async () => {
  await db.ledgerEntry.deleteMany({ where: { id: { notIn: preexistingEntryIds } } })
  await db.jobRun.deleteMany({ where: { id: { notIn: preexistingJobRunIds } } })
  await db.notification.deleteMany({ where: { key: 'rollover:2035' } })

  await db.employeeLeavePolicy.deleteMany({ where: { employeeId } })
  await db.employee.deleteMany({ where: { id: employeeId } })
  await db.leavePolicy.deleteMany({ where: { id: policyId } })
  await db.paySchedule.deleteMany({ where: { id: scheduleId } })
  await db.rolloverRule.deleteMany({ where: { leaveTypeId } })
  await db.leaveType.deleteMany({ where: { id: leaveTypeId } })
})

async function ledger() {
  return db.ledgerEntry.findMany({
    where: { employeeId, leaveTypeId, effectiveDate: { gte: d('2034-12-20') } },
    orderBy: [{ effectiveDate: 'asc' }, { id: 'asc' }],
    select: { effectiveDate: true, minutes: true, kind: true, periodKey: true, jobRunId: true },
  })
}

describe('a rollover run late, over a year whose last pay day was missed', () => {
  it('starts 277 short: 6923 accrued − 2400 spent = 4523', async () => {
    expect(await balanceAsOf(employeeId, leaveTypeId, d('2034-12-31'))).toBe(4523)
  })

  /**
   * 7200 − 6923 = 277 settles the year, closing at 4800; five days (2400)
   * carry and the rest is forfeited — all dated by the boundary, nine days
   * after it, in one run.
   */
  it('settles the last period, then forfeits and carries as of the boundary', async () => {
    const result = await runRollover(d('2035-01-10'))
    expect(result.detail).toMatchObject({
      closingYear: 2034,
      newYear: 2035,
      caughtUp: true,
      failures: 0,
    })

    const rows = await ledger()
    expect(rows.map((e) => [iso(e.effectiveDate), e.minutes, e.kind, e.periodKey])).toEqual([
      ['2034-12-30', 277, 'PERIOD_ACCRUAL', '2034-PP26'],
      ['2035-01-01', -4800, 'FORFEIT', '2035-ROLLOVER'],
      ['2035-01-01', 2400, 'ROLLOVER_IN', '2035-ROLLOVER'],
    ])
    // Written by the run, so the run log can find them.
    expect(rows.every((e) => e.jobRunId === result.jobRunId)).toBe(true)

    expect(await balanceAsOf(employeeId, leaveTypeId, d('2034-12-31'))).toBe(4800)
    expect(await balanceAsOf(employeeId, leaveTypeId, d('2035-01-01'))).toBe(2400)
  })

  it('does not run again on the following days', async () => {
    const result = await runRollover(d('2035-01-11'))
    expect(result.entriesCreated).toBe(0)
    expect(result.detail?.skipped).toBe('already rolled over')
  })

  it('is a no-op if re-run for the boundary itself', async () => {
    const result = await runRollover(d('2035-01-01'))
    expect(result.detail).toMatchObject({ newYear: 2035, rolloversNeedingCorrection: 0 })
    expect((await ledger()).length).toBe(3)
    expect(await balanceAsOf(employeeId, leaveTypeId, d('2035-01-01'))).toBe(2400)
  })
})
