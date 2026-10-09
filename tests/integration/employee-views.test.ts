import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { addDays, todayIn } from '@/lib/accrual/dates'
import { leaveSummariesFor } from '@/lib/dashboard/queries'
import { db } from '@/lib/db'
import { approvedDaysFor } from '@/lib/history/queries'
import type { Actor } from '@/lib/requests/chain'
import { requestStatusCounts, requestsFor, upcomingFor } from '@/lib/requests/queries'
import { decideLeaveRequest, submitLeaveRequest } from '@/lib/requests/service'

/**
 * The employee's own screens against real Postgres: the dashboard summary,
 * the filtered request list, upcoming leave, and history.
 *
 * As in the requests suite, the leave type made here has no accrual policy,
 * so every balance is exactly the ADJUSTMENT posted, and its rollover rule
 * carries everything, so no forfeit is projected whatever today's date is.
 * Namespaced by a run id and torn down afterwards.
 */

const RUN = `vtest-${Date.now().toString(36)}`
const DAY = 480
const HALF = 240

let leaveTypeId: string
let today: Date
let holidays: Set<string>
const employeeIds: string[] = []
let org: { benefitYearStartMonth: number; benefitYearStartDay: number }

const iso = (date: Date) => date.toISOString().slice(0, 10)

function futureDay(n: number): string {
  let day = today
  let found = 0
  while (found < n) {
    day = addDays(day, 1)
    if (!holidays.has(iso(day))) found += 1
  }
  return iso(day)
}

async function person(key: string): Promise<Actor & { employmentType: 'SALARIED_EXEMPT' }> {
  const employee = await db.employee.create({
    data: {
      email: `${RUN}-${key}@example.test`,
      firstName: RUN,
      lastName: key,
      role: 'EMPLOYEE',
      employmentType: 'SALARIED_EXEMPT',
      hireDate: new Date('2015-01-01'),
      standardMinutesPerDay: DAY,
    },
  })
  employeeIds.push(employee.id)
  return { id: employee.id, permissions: [], employmentType: 'SALARIED_EXEMPT' }
}

function form(days: Record<string, number>) {
  return {
    leaveTypeId,
    days: Object.entries(days).map(([date, minutes]) => ({ date, minutes: String(minutes) })),
  }
}

let requester: Awaited<ReturnType<typeof person>>
let other: Awaited<ReturnType<typeof person>>
const ids = { approved: '', pending: '', denied: '', othersApproved: '' }
const dates = { approved: '', pending: '', denied: '' }

beforeAll(async () => {
  const settings = await db.orgSettings.findUnique({ where: { id: 1 } })
  if (!settings) throw new Error('Run `npm run db:seed` before the integration tests.')
  org = settings
  today = todayIn(settings.timezone)
  holidays = new Set((await db.holiday.findMany({ select: { date: true } })).map((h) => iso(h.date)))

  const type = await db.leaveType.create({
    data: {
      code: `${RUN}-PTO`,
      name: `${RUN} PTO`,
      countsTowardRollover: true,
      rolloverRule: { create: { capBasis: 'UNLIMITED' } },
    },
  })
  leaveTypeId = type.id

  const approver = await person('approver')
  requester = await person('requester')
  other = await person('other')

  for (const who of [requester, other]) {
    await db.approvalChainStep.create({
      data: { employeeId: who.id, step: 1, approverId: approver.id },
    })
    await db.ledgerEntry.create({
      data: {
        employeeId: who.id,
        leaveTypeId,
        effectiveDate: today,
        minutes: 2400,
        kind: 'ADJUSTMENT',
        note: 'integration test balance',
      },
    })
  }

  dates.approved = futureDay(5)
  dates.pending = futureDay(8)
  dates.denied = futureDay(12)

  ids.approved = (await submitLeaveRequest(requester, form({ [dates.approved]: DAY }))).id
  await decideLeaveRequest(approver, { requestId: ids.approved, decision: 'APPROVE' })

  ids.pending = (await submitLeaveRequest(requester, form({ [dates.pending]: HALF }))).id

  ids.denied = (await submitLeaveRequest(requester, form({ [dates.denied]: DAY }))).id
  await decideLeaveRequest(approver, { requestId: ids.denied, decision: 'DENY' })

  // Someone else's approved leave on the same type, which must never show up
  // on the requester's screens.
  ids.othersApproved = (await submitLeaveRequest(other, form({ [dates.approved]: DAY }))).id
  await decideLeaveRequest(approver, { requestId: ids.othersApproved, decision: 'APPROVE' })
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
  await db.ledgerEntry.deleteMany({ where: { leaveTypeId } })
  await db.approvalChainStep.deleteMany({ where: { employeeId: { in: employeeIds } } })
  await db.employee.deleteMany({ where: { id: { in: employeeIds } } })
  await db.leaveType.deleteMany({ where: { id: leaveTypeId } })
})

describe('the dashboard summary', () => {
  it('splits the balance into what is booked and what is pending', async () => {
    const summaries = await leaveSummariesFor(requester, org, today)
    const summary = summaries.find((s) => s.id === leaveTypeId)

    expect(summary).toMatchObject({
      // The approved day is still in today's balance — it has not been taken.
      balanceMinutes: 2400,
      bookedMinutes: DAY,
      // The denied request holds nothing; the pending half day does.
      pendingMinutes: HALF,
      nextAccrual: null,
      loss: null,
    })
  })
})

describe('upcoming leave', () => {
  it('lists the employee’s own approved requests and nothing else', async () => {
    const upcoming = await upcomingFor(requester.id, today)
    expect(upcoming.map((r) => r.id)).toEqual([ids.approved])
  })
})

describe('the request list', () => {
  it('filters by status and by type, within the employee’s own requests', async () => {
    const all = await requestsFor(requester.id)
    expect(new Set(all.map((r) => r.id))).toEqual(new Set([ids.approved, ids.pending, ids.denied]))

    const pending = await requestsFor(requester.id, { status: 'PENDING' })
    expect(pending.map((r) => r.id)).toEqual([ids.pending])

    const ofType = await requestsFor(requester.id, { type: leaveTypeId, status: 'DENIED' })
    expect(ofType.map((r) => r.id)).toEqual([ids.denied])

    const otherType = await requestsFor(requester.id, { type: 'cnotarealtype' })
    expect(otherType).toEqual([])
  })

  it('counts requests by status', async () => {
    const counts = await requestStatusCounts(requester.id, leaveTypeId)
    expect(Object.fromEntries(counts)).toEqual({ APPROVED: 1, PENDING: 1, DENIED: 1 })
  })
})

describe('history', () => {
  it('holds approved days only — not pending, not denied, not anyone else’s', async () => {
    const days = await approvedDaysFor(requester.id)
    expect(days.map((d) => [iso(d.date), d.minutes, d.requestId])).toEqual([
      [dates.approved, DAY, ids.approved],
    ])
  })
})
