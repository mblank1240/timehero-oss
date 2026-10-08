import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { addDays, benefitYearContaining, todayIn } from '@/lib/accrual/dates'
import { db } from '@/lib/db'
import { runExpireLots as expire } from '@/lib/jobs/expire'
import { runJob } from '@/lib/jobs/runner'
import { balanceAsOf } from '@/lib/ledger/balance'
import type { Actor } from '@/lib/requests/chain'
import { RequestError, decideLeaveRequest } from '@/lib/requests/service'

/**
 * Leave requests whose last approval comes too late: after the benefit year
 * they were for has closed, or after the time they would spend has expired.
 * Both used to be approved and written; both must now be refused, leaving the
 * request pending for the approver to deny.
 *
 * The requests are written straight to the database, as they would stand had
 * they been submitted in time — submission today would refuse them, which is
 * the point. Dates count from the org's today so the suite does not rot.
 */

const RUN = `latest-${Date.now().toString(36)}`
const DAY = 480

let leaveTypeId: string
let today: Date
let yearStart: Date
const employeeIds: string[] = []
let preexistingEntryIds: string[] = []
let preexistingJobRunIds: string[] = []

const iso = (date: Date) => date.toISOString().slice(0, 10)

async function person(key: string): Promise<Actor> {
  const employee = await db.employee.create({
    data: {
      email: `${RUN}-${key}@example.test`,
      firstName: RUN,
      lastName: key,
      employmentType: 'SALARIED_EXEMPT',
      hireDate: new Date('2015-01-01'),
      standardMinutesPerDay: DAY,
    },
  })
  employeeIds.push(employee.id)
  return { id: employee.id, role: employee.role }
}

/** A request as it stood when submitted: pending, on step 1 of 1. */
async function pendingRequest(employeeId: string, approverId: string, date: Date) {
  return db.leaveRequest.create({
    data: {
      employeeId,
      leaveTypeId,
      status: 'PENDING',
      totalMinutes: DAY,
      submittedAt: new Date(),
      days: { create: [{ date, minutes: DAY }] },
      steps: { create: [{ step: 1, approverId }] },
    },
    select: { id: true },
  })
}

async function refusal(promise: Promise<unknown>): Promise<RequestError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(RequestError)
  return error as RequestError
}

async function state(requestId: string) {
  const request = await db.leaveRequest.findUniqueOrThrow({
    where: { id: requestId },
    select: { status: true, steps: { select: { status: true } } },
  })
  const usage = await db.ledgerEntry.count({
    where: { sourceType: 'LeaveRequest', sourceId: requestId },
  })
  return { status: request.status, steps: request.steps.map((s) => s.status), usage }
}

beforeAll(async () => {
  preexistingEntryIds = (await db.ledgerEntry.findMany({ select: { id: true } })).map((r) => r.id)
  preexistingJobRunIds = (await db.jobRun.findMany({ select: { id: true } })).map((r) => r.id)

  const org = await db.orgSettings.findUnique({ where: { id: 1 } })
  if (!org) throw new Error('Run `npm run db:seed` before the integration tests.')
  today = todayIn(org.timezone)
  yearStart = benefitYearContaining(
    today,
    org.benefitYearStartMonth,
    org.benefitYearStartDay,
  ).start

  const type = await db.leaveType.create({
    data: { code: `${RUN}-COMP`, name: `${RUN} Comp`, countsTowardRollover: false },
  })
  leaveTypeId = type.id
})

afterAll(async () => {
  const requests = await db.leaveRequest.findMany({
    where: { employeeId: { in: employeeIds } },
    select: { id: true },
  })
  await db.auditLog.deleteMany({
    where: { entityType: 'LeaveRequest', entityId: { in: requests.map((r) => r.id) } },
  })
  await db.leaveRequest.deleteMany({ where: { employeeId: { in: employeeIds } } })
  // The expiry job is org-wide: whatever it wrote for anyone goes too.
  await db.ledgerEntry.deleteMany({ where: { id: { notIn: preexistingEntryIds } } })
  await db.ledgerEntry.deleteMany({ where: { leaveTypeId } })
  await db.jobRun.deleteMany({ where: { id: { notIn: preexistingJobRunIds } } })
  await db.employee.deleteMany({ where: { id: { in: employeeIds } } })
  await db.leaveType.deleteMany({ where: { id: leaveTypeId } })
})

describe('final approval of a request for a benefit year that has since closed', () => {
  /**
   * Submitted in December, approved in January. The year rolled over without
   * it, so its USAGE would come out of the new year's balance instead.
   */
  it('is refused, and nothing is written', async () => {
    const approver = await person('closed-approver')
    const requester = await person('closed')
    // Enough time, before the leave day: the balance check alone would pass.
    await db.ledgerEntry.create({
      data: {
        employeeId: requester.id,
        leaveTypeId,
        effectiveDate: addDays(yearStart, -10),
        minutes: 2 * DAY,
        kind: 'ADJUSTMENT',
        note: 'integration test balance',
      },
    })

    const lastYearsDay = addDays(yearStart, -3)
    const { id } = await pendingRequest(requester.id, approver.id, lastYearsDay)

    const error = await refusal(decideLeaveRequest(approver, { requestId: id, decision: 'APPROVE' }))
    expect(error.message).toContain(`${iso(lastYearsDay)} is in a benefit year that has already closed`)
    expect(error.message).toMatch(/can no longer be approved\. Deny it/)

    expect(await state(id)).toEqual({ status: 'PENDING', steps: ['PENDING'], usage: 0 })
    expect(await balanceAsOf(requester.id, leaveTypeId, today)).toBe(2 * DAY)

    // Denying it is still possible, and is what the message asks for.
    expect(await decideLeaveRequest(approver, { requestId: id, decision: 'DENY' })).toBe('DENIED')
  })
})

describe('final approval after the time it spends has expired', () => {
  /**
   * 480 granted ten days ago, spendable through three days ago. The request
   * is for four days ago, so it was affordable when submitted. The expiry job
   * then forfeits the unspent 480, dated two days ago. Approving now would
   * write a USAGE of 480 against a lot already forfeited: 480 − 480 − 480.
   */
  it('is refused instead of taking the balance to −480', async (ctx) => {
    const granted = addDays(today, -10)
    // Needs the whole story inside one benefit year.
    if (granted < yearStart) ctx.skip()

    const approver = await person('expired-approver')
    const requester = await person('expired')
    const expiresOn = addDays(today, -3)
    const leaveDay = addDays(today, -4)

    await db.ledgerEntry.create({
      data: {
        employeeId: requester.id,
        leaveTypeId,
        effectiveDate: granted,
        minutes: DAY,
        kind: 'COMP_EARNED',
        expiresOn,
      },
    })
    const { id } = await pendingRequest(requester.id, approver.id, leaveDay)

    await runJob({ jobName: 'expire-lots' }, (run) => expire(today, run))
    const forfeitDay = addDays(expiresOn, 1)
    expect(await balanceAsOf(requester.id, leaveTypeId, forfeitDay)).toBe(0)

    const error = await refusal(decideLeaveRequest(approver, { requestId: id, decision: 'APPROVE' }))
    expect(error.message).toMatch(/balance no longer covers this request/)
    expect(error.message).toContain(`on ${iso(forfeitDay)}`)

    expect(await state(id)).toEqual({ status: 'PENDING', steps: ['PENDING'], usage: 0 })
    expect(await balanceAsOf(requester.id, leaveTypeId, today)).toBe(0)
  })

  it('is approved when the time is still there', async (ctx) => {
    const granted = addDays(today, -10)
    if (granted < yearStart) ctx.skip()

    const approver = await person('live-approver')
    const requester = await person('live')
    await db.ledgerEntry.create({
      data: {
        employeeId: requester.id,
        leaveTypeId,
        effectiveDate: granted,
        minutes: DAY,
        kind: 'COMP_EARNED',
        // Spendable through today.
        expiresOn: today,
      },
    })
    const { id } = await pendingRequest(requester.id, approver.id, addDays(today, -4))

    await runJob({ jobName: 'expire-lots' }, (run) => expire(today, run))
    expect(await decideLeaveRequest(approver, { requestId: id, decision: 'APPROVE' })).toBe(
      'APPROVED',
    )
    expect(await state(id)).toMatchObject({ status: 'APPROVED', usage: 1 })
    // Spent before it expired, so tomorrow's expiry finds nothing left.
    expect(await balanceAsOf(requester.id, leaveTypeId, today)).toBe(0)
  })
})
