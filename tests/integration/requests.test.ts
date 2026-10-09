import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { addDays, todayIn } from '@/lib/accrual/dates'
import { db } from '@/lib/db'
import { balanceAsOf } from '@/lib/ledger/balance'
import type { Actor } from '@/lib/requests/chain'
import {
  RequestError,
  amendLeaveRequest,
  cancelLeaveRequest,
  decideLeaveRequest,
  rerouteLeaveRequest,
  submitLeaveRequest,
} from '@/lib/requests/service'

/**
 * Leave requests end to end against real Postgres: submission, a three-step
 * chain, denial, cancellation, overrides, and the two balance checks.
 *
 * The leave type made here has no accrual policy, so every balance is exactly
 * the ADJUSTMENT a test posts — nothing is projected on top of it, and the
 * figures can be checked by eye. Request dates are counted forward from the
 * org's today, skipping holidays, so the suite does not rot as the calendar
 * moves.
 *
 * Namespaced by a run id and torn down afterwards, like the ledger suite.
 */

const RUN = `rtest-${Date.now().toString(36)}`
const DAY = 480
const HALF = 240

let leaveTypeId: string
let today: Date
let holidays: Set<string>
const employeeIds: string[] = []
let originalIncrement: number

const iso = (date: Date) => date.toISOString().slice(0, 10)

/** The `n`th non-holiday day after today. */
function futureDay(n: number): string {
  let day = today
  let found = 0
  while (found < n) {
    day = addDays(day, 1)
    if (!holidays.has(iso(day))) found += 1
  }
  return iso(day)
}

async function person(
  key: string,
  opts: { role?: 'ADMIN' | 'EMPLOYEE'; balance?: number } = {},
): Promise<Actor> {
  const employee = await db.employee.create({
    data: {
      email: `${RUN}-${key}@example.test`,
      firstName: RUN,
      lastName: key,
      role: opts.role ?? 'EMPLOYEE',
      employmentType: 'SALARIED_EXEMPT',
      hireDate: new Date('2015-01-01'),
      standardMinutesPerDay: DAY,
    },
  })
  employeeIds.push(employee.id)

  if (opts.balance) await adjust(employee.id, opts.balance)
  return { id: employee.id, role: employee.role }
}

async function adjust(employeeId: string, minutes: number) {
  await db.ledgerEntry.create({
    data: {
      employeeId,
      leaveTypeId,
      effectiveDate: today,
      minutes,
      kind: 'ADJUSTMENT',
      note: 'integration test balance',
    },
  })
}

async function chain(employeeId: string, approvers: Actor[]) {
  await db.approvalChainStep.createMany({
    data: approvers.map((a, i) => ({ employeeId, step: i + 1, approverId: a.id })),
  })
}

/** A request posted as the form would post it. */
function form(days: Record<string, number>, note?: string) {
  return {
    leaveTypeId,
    note,
    days: Object.entries(days).map(([date, minutes]) => ({ date, minutes: String(minutes) })),
  }
}

async function steps(requestId: string) {
  return db.approvalStep.findMany({
    where: { leaveRequestId: requestId },
    orderBy: { step: 'asc' },
    select: { step: true, approverId: true, status: true, decidedById: true, comment: true },
  })
}

async function usage(requestId: string) {
  return db.ledgerEntry.findMany({
    where: { sourceType: 'LeaveRequest', sourceId: requestId },
    orderBy: [{ effectiveDate: 'asc' }, { kind: 'asc' }],
    select: { effectiveDate: true, minutes: true, kind: true },
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

beforeAll(async () => {
  const org = await db.orgSettings.findUnique({ where: { id: 1 } })
  if (!org) throw new Error('Run `npm run db:seed` before the integration tests.')
  originalIncrement = org.minimumRequestIncrementMinutes
  // The figures below are written against the church's half-day increment.
  expect(originalIncrement).toBe(HALF)

  today = todayIn(org.timezone)
  holidays = new Set(
    (await db.holiday.findMany({ select: { date: true } })).map((h) => iso(h.date)),
  )

  const type = await db.leaveType.create({
    data: {
      code: `${RUN}-PTO`,
      name: `${RUN} PTO`,
      countsTowardRollover: true,
      // Everything carries. The dates below reach up to ~80 working days
      // ahead; from October on that crosses the benefit year, and with no
      // rule the balance would be forfeited at the boundary.
      rolloverRule: { create: { capBasis: 'UNLIMITED' } },
    },
  })
  leaveTypeId = type.id
})

afterAll(async () => {
  await db.orgSettings.update({
    where: { id: 1 },
    data: { minimumRequestIncrementMinutes: originalIncrement },
  })

  const requests = await db.leaveRequest.findMany({
    where: { employeeId: { in: employeeIds } },
    select: { id: true },
  })
  await db.auditLog.deleteMany({
    where: { entityType: 'LeaveRequest', entityId: { in: requests.map((r) => r.id) } },
  })
  // Requests before employees: a step's approver is onDelete Restrict.
  await db.leaveRequest.deleteMany({ where: { employeeId: { in: employeeIds } } })
  await db.ledgerEntry.deleteMany({ where: { leaveTypeId } })
  await db.approvalChainStep.deleteMany({ where: { employeeId: { in: employeeIds } } })
  await db.employee.deleteMany({ where: { id: { in: employeeIds } } })
  await db.leaveType.deleteMany({ where: { id: leaveTypeId } })
})

describe('a three-step chain', () => {
  it('moves a request end to end and moves the balance correctly', async () => {
    const [a, b, c] = [await person('a'), await person('b'), await person('c')]
    const requester = await person('three-step', { balance: 2400 })
    await chain(requester.id, [a, b, c])

    const [d1, d2] = [futureDay(10), futureDay(11)]
    const { id, status } = await submitLeaveRequest(requester, form({ [d1]: DAY, [d2]: HALF }))
    expect(status).toBe('PENDING')
    expect((await steps(id)).map((s) => s.status)).toEqual(['PENDING', 'PENDING', 'PENDING'])

    // Out of order: the request is waiting on step 1, not on B.
    const early = await refusal(decideLeaveRequest(b, { requestId: id, decision: 'APPROVE' }))
    expect(early.message).toMatch(/not waiting on you/)

    expect(await decideLeaveRequest(a, { requestId: id, decision: 'APPROVE' })).toBe('ADVANCED')
    expect(await decideLeaveRequest(b, { requestId: id, decision: 'APPROVE' })).toBe('ADVANCED')
    // Nothing touches the ledger until the last step.
    expect(await usage(id)).toEqual([])

    expect(await decideLeaveRequest(c, { requestId: id, decision: 'APPROVE' })).toBe('APPROVED')

    const request = await db.leaveRequest.findUniqueOrThrow({ where: { id } })
    expect(request.status).toBe('APPROVED')
    expect(request.resolvedAt).not.toBeNull()

    expect((await steps(id)).map((s) => [s.status, s.decidedById])).toEqual([
      ['APPROVED', a.id],
      ['APPROVED', b.id],
      ['APPROVED', c.id],
    ])

    // One USAGE per day, dated on the day, signed negative.
    expect((await usage(id)).map((e) => [iso(e.effectiveDate), e.minutes, e.kind])).toEqual([
      [d1, -DAY, 'USAGE'],
      [d2, -HALF, 'USAGE'],
    ])

    expect(await balanceAsOf(requester.id, leaveTypeId, today)).toBe(2400)
    expect(await balanceAsOf(requester.id, leaveTypeId, new Date(`${d1}T00:00:00Z`))).toBe(1920)
    expect(await balanceAsOf(requester.id, leaveTypeId, new Date(`${d2}T00:00:00Z`))).toBe(1680)

    // A decided request cannot be decided again.
    const again = await refusal(decideLeaveRequest(c, { requestId: id, decision: 'APPROVE' }))
    expect(again.message).toMatch(/already been decided/)
  })

  it('ends at the first denial, and never reaches the later steps', async () => {
    const [a, b, c] = [await person('deny-a'), await person('deny-b'), await person('deny-c')]
    const requester = await person('denied', { balance: 2400 })
    await chain(requester.id, [a, b, c])

    const { id } = await submitLeaveRequest(requester, form({ [futureDay(12)]: DAY }))
    await decideLeaveRequest(a, { requestId: id, decision: 'APPROVE' })
    expect(
      await decideLeaveRequest(b, { requestId: id, decision: 'DENY', comment: 'Short-staffed' }),
    ).toBe('DENIED')

    expect((await steps(id)).map((s) => s.status)).toEqual(['APPROVED', 'DENIED', 'SKIPPED'])
    expect((await db.leaveRequest.findUniqueOrThrow({ where: { id } })).status).toBe('DENIED')
    expect(await usage(id)).toEqual([])

    const late = await refusal(decideLeaveRequest(c, { requestId: id, decision: 'APPROVE' }))
    expect(late.message).toMatch(/already been decided/)
  })

  /** Two approvals at once must produce one set of USAGE entries, not two. */
  it('serialises a double-click on the final approval', async () => {
    const approver = await person('race-approver')
    const requester = await person('race', { balance: 2400 })
    await chain(requester.id, [approver])

    const { id } = await submitLeaveRequest(requester, form({ [futureDay(13)]: DAY }))
    const results = await Promise.allSettled([
      decideLeaveRequest(approver, { requestId: id, decision: 'APPROVE' }),
      decideLeaveRequest(approver, { requestId: id, decision: 'APPROVE' }),
    ])

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(await usage(id)).toHaveLength(1)
  })
})

describe('the minimum increment', () => {
  it('rejects a 3-hour request at a 240-minute increment', async () => {
    const requester = await person('three-hours', { balance: 2400 })
    const date = futureDay(20)

    const error = await refusal(submitLeaveRequest(requester, form({ [date]: 180 })))
    expect(error.fieldErrors?.[`day.${date}`]?.join(' ')).toMatch(/multiple/)
    expect(await db.leaveRequest.count({ where: { employeeId: requester.id } })).toBe(0)
  })

  it('accepts a 180-minute request when that is the entire remaining balance', async () => {
    const requester = await person('stranded', { balance: 180 })

    const { id } = await submitLeaveRequest(requester, form({ [futureDay(21)]: 180 }))
    const days = await db.leaveRequestDay.findMany({ where: { leaveRequestId: id } })
    expect(days.map((d) => d.minutes)).toEqual([180])
  })

  it('refuses the same 180 when it is not the whole balance', async () => {
    const requester = await person('not-stranded', { balance: 200 })
    const date = futureDay(22)

    const error = await refusal(submitLeaveRequest(requester, form({ [date]: 180 })))
    expect(error.fieldErrors?.[`day.${date}`]).toBeDefined()
  })

  it('never lets the exception cover more than one day', async () => {
    const requester = await person('stranded-two-days', { balance: 180 })

    await refusal(submitLeaveRequest(requester, form({ [futureDay(23)]: 90, [futureDay(24)]: 90 })))
  })

  it('invalidates half days at once when the org moves to 480, without touching existing requests', async () => {
    const approver = await person('increment-approver')
    const requester = await person('increment', { balance: 2400 })
    await chain(requester.id, [approver])

    const before = await submitLeaveRequest(requester, form({ [futureDay(25)]: HALF }))

    await db.orgSettings.update({ where: { id: 1 }, data: { minimumRequestIncrementMinutes: DAY } })
    try {
      const date = futureDay(26)
      const error = await refusal(submitLeaveRequest(requester, form({ [date]: HALF })))
      expect(error.fieldErrors?.[`day.${date}`]).toBeDefined()

      // A full day is still fine.
      await submitLeaveRequest(requester, form({ [futureDay(27)]: DAY }))

      // The half-day request made before the change is exactly as it was,
      // and its approval is a balance question, not an increment one.
      const existing = await db.leaveRequest.findUniqueOrThrow({
        where: { id: before.id },
        include: { days: true },
      })
      expect(existing.status).toBe('PENDING')
      expect(existing.days.map((d) => d.minutes)).toEqual([HALF])
      expect(
        await decideLeaveRequest(approver, { requestId: before.id, decision: 'APPROVE' }),
      ).toBe('APPROVED')
    } finally {
      await db.orgSettings.update({
        where: { id: 1 },
        data: { minimumRequestIncrementMinutes: originalIncrement },
      })
    }
  })
})

describe('balance checks', () => {
  it('blocks a submission the balance cannot cover', async () => {
    const requester = await person('short', { balance: HALF })

    const error = await refusal(submitLeaveRequest(requester, form({ [futureDay(30)]: DAY })))
    expect(error.message).toMatch(/not enough time/)
  })

  it('counts other pending requests against the balance', async () => {
    const requester = await person('holds', { balance: DAY })

    await submitLeaveRequest(requester, form({ [futureDay(31)]: DAY }))
    const error = await refusal(submitLeaveRequest(requester, form({ [futureDay(32)]: DAY })))
    expect(error.message).toMatch(/not enough time/)
  })

  it('catches a request that would starve later approved leave', async () => {
    const approver = await person('starve-approver')
    const requester = await person('starve', { balance: DAY })
    await chain(requester.id, [approver])

    const later = await submitLeaveRequest(requester, form({ [futureDay(40)]: DAY }))
    await decideLeaveRequest(approver, { requestId: later.id, decision: 'APPROVE' })

    // Affordable on its own date, but leaves the approved day uncovered.
    await refusal(submitLeaveRequest(requester, form({ [futureDay(35)]: HALF })))
  })

  it('checks again at final approval, and writes nothing when the time has gone', async () => {
    const approver = await person('recheck-approver')
    const requester = await person('recheck', { balance: DAY })
    await chain(requester.id, [approver])

    const { id } = await submitLeaveRequest(requester, form({ [futureDay(41)]: DAY }))
    // The time is spent some other way before the approver gets to it.
    await adjust(requester.id, -DAY)

    const error = await refusal(
      decideLeaveRequest(approver, { requestId: id, decision: 'APPROVE' }),
    )
    expect(error.message).toMatch(/no longer covers/)

    // Rolled back whole: still pending, still waiting on the same step.
    expect((await db.leaveRequest.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING')
    expect((await steps(id)).map((s) => s.status)).toEqual(['PENDING'])
    expect(await usage(id)).toEqual([])
  })

  it('refuses a holiday', async () => {
    const requester = await person('holiday', { balance: 2400 })
    const holiday = [...holidays].sort().find((h) => h > iso(today))
    if (!holiday) return // Nothing seeded ahead of today to test against.

    const error = await refusal(submitLeaveRequest(requester, form({ [holiday]: DAY })))
    expect(error.fieldErrors?.[`day.${holiday}`]?.join(' ')).toMatch(/holiday/)
  })

  it('refuses more than a working day on one date across requests', async () => {
    const requester = await person('double-booked', { balance: 2400 })
    const date = futureDay(42)

    await submitLeaveRequest(requester, form({ [date]: HALF }))
    await submitLeaveRequest(requester, form({ [date]: HALF }))
    const error = await refusal(submitLeaveRequest(requester, form({ [date]: HALF })))
    expect(error.fieldErrors?.[`day.${date}`]?.join(' ')).toMatch(/already has/)
  })
})

describe('chain snapshots', () => {
  it('skips the requester when they appear in their own chain', async () => {
    const other = await person('self-other')
    const requester = await person('self', { balance: 2400 })
    await chain(requester.id, [requester, other])

    const { id } = await submitLeaveRequest(requester, form({ [futureDay(50)]: DAY }))
    expect((await steps(id)).map((s) => [s.approverId, s.status])).toEqual([
      [requester.id, 'SKIPPED'],
      [other.id, 'PENDING'],
    ])

    const own = await refusal(decideLeaveRequest(requester, { requestId: id, decision: 'APPROVE' }))
    expect(own.message).toMatch(/your own/)
    expect(await decideLeaveRequest(other, { requestId: id, decision: 'APPROVE' })).toBe('APPROVED')
  })

  it('routes an empty chain to any administrator', async () => {
    const admin = await person('empty-admin', { role: 'ADMIN' })
    const bystander = await person('empty-bystander')
    const requester = await person('empty', { balance: 2400 })

    const { id } = await submitLeaveRequest(requester, form({ [futureDay(51)]: DAY }))
    expect((await steps(id)).map((s) => [s.approverId, s.status])).toEqual([[null, 'PENDING']])

    await refusal(decideLeaveRequest(bystander, { requestId: id, decision: 'APPROVE' }))
    expect(await decideLeaveRequest(admin, { requestId: id, decision: 'APPROVE' })).toBe('APPROVED')
  })

  it('does not let an administrator approve their own request from the admin queue', async () => {
    const requester = await person('admin-self', { role: 'ADMIN', balance: 2400 })
    const { id } = await submitLeaveRequest(requester, form({ [futureDay(52)]: DAY }))

    await refusal(decideLeaveRequest(requester, { requestId: id, decision: 'APPROVE' }))
    await refusal(
      decideLeaveRequest(requester, { requestId: id, decision: 'APPROVE', overrideReason: 'Mine' }),
    )
  })

  it('is refused by the database even when the service is bypassed', async () => {
    const other = await person('trigger-other')
    const requester = await person('trigger', { balance: 2400 })
    await chain(requester.id, [other])
    const { id } = await submitLeaveRequest(requester, form({ [futureDay(53)]: DAY }))

    await expect(
      db.approvalStep.updateMany({
        where: { leaveRequestId: id },
        data: { status: 'APPROVED', decidedById: requester.id, decidedAt: new Date() },
      }),
    ).rejects.toThrow(/may not decide their own/)
  })

  it('is not rewritten by a later edit to the chain', async () => {
    const [a, b] = [await person('snap-a'), await person('snap-b')]
    const requester = await person('snap', { balance: 2400 })
    await chain(requester.id, [a])

    const { id } = await submitLeaveRequest(requester, form({ [futureDay(54)]: DAY }))
    await db.approvalChainStep.updateMany({
      where: { employeeId: requester.id },
      data: { approverId: b.id },
    })

    expect((await steps(id)).map((s) => s.approverId)).toEqual([a.id])
  })
})

describe('cancellation', () => {
  it('cancels a pending request and closes its steps', async () => {
    const approver = await person('cancel-pending-approver')
    const requester = await person('cancel-pending', { balance: 2400 })
    await chain(requester.id, [approver])

    const { id } = await submitLeaveRequest(requester, form({ [futureDay(60)]: DAY }))
    await cancelLeaveRequest(requester, { requestId: id })

    expect((await db.leaveRequest.findUniqueOrThrow({ where: { id } })).status).toBe('CANCELLED')
    expect((await steps(id)).map((s) => s.status)).toEqual(['SKIPPED'])
    expect(await usage(id)).toEqual([])
  })

  it('reverses approved future leave and keeps the original entries', async () => {
    const approver = await person('cancel-approved-approver')
    const requester = await person('cancel-approved', { balance: 2400 })
    await chain(requester.id, [approver])

    const date = futureDay(61)
    const { id } = await submitLeaveRequest(requester, form({ [date]: DAY }))
    await decideLeaveRequest(approver, { requestId: id, decision: 'APPROVE' })
    expect(await balanceAsOf(requester.id, leaveTypeId, new Date(`${date}T00:00:00Z`))).toBe(1920)

    await cancelLeaveRequest(requester, { requestId: id })

    expect((await usage(id)).map((e) => [iso(e.effectiveDate), e.minutes, e.kind])).toEqual([
      [date, -DAY, 'USAGE'],
      [date, DAY, 'USAGE_REVERSAL'],
    ])
    expect(await balanceAsOf(requester.id, leaveTypeId, new Date(`${date}T00:00:00Z`))).toBe(2400)
  })

  it('needs a reason when an administrator cancels someone else’s request', async () => {
    const admin = await person('cancel-admin', { role: 'ADMIN' })
    const requester = await person('cancel-by-admin', { balance: 2400 })
    const { id } = await submitLeaveRequest(requester, form({ [futureDay(62)]: DAY }))

    const error = await refusal(cancelLeaveRequest(admin, { requestId: id }))
    expect(error.fieldErrors?.reason).toBeDefined()

    await cancelLeaveRequest(admin, { requestId: id, reason: 'Duplicate of another request' })
    expect((await db.leaveRequest.findUniqueOrThrow({ where: { id } })).status).toBe('CANCELLED')
  })

  it('is not open to anyone else', async () => {
    const stranger = await person('cancel-stranger')
    const requester = await person('cancel-target', { balance: 2400 })
    const { id } = await submitLeaveRequest(requester, form({ [futureDay(63)]: DAY }))

    await refusal(cancelLeaveRequest(stranger, { requestId: id, reason: 'Because' }))
  })
})

describe('administrator overrides', () => {
  it('approves, skips and reroutes, each with a reason on record', async () => {
    const admin = await person('override-admin', { role: 'ADMIN' })
    const [a, b, c, d] = [
      await person('ov-a'),
      await person('ov-b'),
      await person('ov-c'),
      await person('ov-d'),
    ]
    const requester = await person('override', { balance: 2400 })
    await chain(requester.id, [a, b, c])

    const { id } = await submitLeaveRequest(requester, form({ [futureDay(70)]: DAY }))

    // A non-admin cannot override, reason or not.
    await refusal(
      decideLeaveRequest(d, { requestId: id, decision: 'APPROVE', overrideReason: 'Hm' }),
    )

    await decideLeaveRequest(admin, {
      requestId: id,
      decision: 'APPROVE',
      overrideReason: 'A is on sabbatical',
    })
    await decideLeaveRequest(admin, {
      requestId: id,
      decision: 'SKIP',
      overrideReason: 'B delegated to the board chair',
    })

    await refusal(
      rerouteLeaveRequest(admin, { requestId: id, approverId: requester.id, reason: 'Nope' }),
    )
    await rerouteLeaveRequest(admin, { requestId: id, approverId: d.id, reason: 'C has left' })

    // The original approver is no longer the one it waits on.
    await refusal(decideLeaveRequest(c, { requestId: id, decision: 'APPROVE' }))
    expect(await decideLeaveRequest(d, { requestId: id, decision: 'APPROVE' })).toBe('APPROVED')

    expect(
      (await steps(id)).map((s) => [s.approverId, s.status, s.decidedById, s.comment]),
    ).toEqual([
      [a.id, 'APPROVED', admin.id, 'A is on sabbatical'],
      [b.id, 'SKIPPED', admin.id, 'B delegated to the board chair'],
      [d.id, 'APPROVED', d.id, null],
    ])

    const audit = await db.auditLog.findMany({
      where: { entityType: 'LeaveRequest', entityId: id },
      orderBy: { createdAt: 'asc' },
      select: { action: true, reason: true },
    })
    expect(audit.map((r) => r.action)).toEqual([
      'leaveRequest.submit',
      'leaveRequest.override.approve',
      'leaveRequest.override.skip',
      'leaveRequest.override.reroute',
      'leaveRequest.approve',
    ])
    expect(audit.filter((r) => r.action.includes('override')).every((r) => r.reason)).toBe(true)
  })

  it('approves the request when the last step is skipped', async () => {
    const admin = await person('skip-last-admin', { role: 'ADMIN' })
    const approver = await person('skip-last-approver')
    const requester = await person('skip-last', { balance: 2400 })
    await chain(requester.id, [approver])

    const { id } = await submitLeaveRequest(requester, form({ [futureDay(71)]: DAY }))
    expect(
      await decideLeaveRequest(admin, {
        requestId: id,
        decision: 'SKIP',
        overrideReason: 'On leave',
      }),
    ).toBe('APPROVED')
    expect(await usage(id)).toHaveLength(1)
  })
})

describe('an administrator entering leave for someone', () => {
  it('records leave as already approved, with the reason on record', async () => {
    const admin = await person('record-admin', { role: 'ADMIN' })
    const employee = await person('record', { balance: DAY * 2 })
    const date = futureDay(80)

    const result = await submitLeaveRequest(employee, form({}), undefined).catch(() => null)
    expect(result).toBeNull() // no days: the schema refuses an empty request

    const { id, status } = await submitLeaveRequest(admin, form({ [date]: DAY }), {
      employeeId: employee.id,
      reason: 'Called in sick; does not use the app',
      approveNow: true,
      allowOverdraw: false,
    })
    expect(status).toBe('APPROVED')

    const request = await db.leaveRequest.findUniqueOrThrow({
      where: { id },
      select: { employeeId: true, _count: { select: { steps: true } } },
    })
    expect(request.employeeId).toBe(employee.id)
    expect(request._count.steps).toBe(0)
    expect(await balanceAsOf(employee.id, leaveTypeId, new Date(`${date}T00:00:00.000Z`))).toBe(DAY)

    const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: id } })
    expect(audit).toMatchObject({
      action: 'leaveRequest.override.record',
      actorId: admin.id,
      reason: 'Called in sick; does not use the app',
    })
  })

  it('sends it through the employee’s own chain when not recorded as approved', async () => {
    const admin = await person('route-admin', { role: 'ADMIN' })
    const approver = await person('route-approver')
    const employee = await person('route', { balance: DAY })
    await chain(employee.id, [approver])

    const { id, status } = await submitLeaveRequest(admin, form({ [futureDay(81)]: DAY }), {
      employeeId: employee.id,
      reason: 'Entered from a paper form',
      approveNow: false,
      allowOverdraw: false,
    })
    expect(status).toBe('PENDING')
    expect((await steps(id)).map((s) => [s.approverId, s.status])).toEqual([
      [approver.id, 'PENDING'],
    ])
  })

  it('overdraws only when the administrator says so, and only when recording as approved', async () => {
    const admin = await person('overdraw-admin', { role: 'ADMIN' })
    const employee = await person('overdraw', { balance: HALF })
    const days = form({ [futureDay(82)]: DAY })
    const onBehalf = {
      employeeId: employee.id,
      reason: 'Extended sick leave agreed by the board',
      approveNow: true,
      allowOverdraw: false,
    }

    expect((await refusal(submitLeaveRequest(admin, days, onBehalf))).message).toMatch(
      /not enough time/,
    )
    await refusal(
      submitLeaveRequest(admin, days, { ...onBehalf, approveNow: false, allowOverdraw: true }),
    )
    await submitLeaveRequest(admin, days, { ...onBehalf, allowOverdraw: true })
    expect(await balanceAsOf(employee.id, leaveTypeId, addDays(today, 400))).toBe(HALF - DAY)
  })

  it('is for administrators only, and not for their own leave', async () => {
    const admin = await person('self-admin', { role: 'ADMIN', balance: DAY })
    const other = await person('not-admin')
    const employee = await person('target', { balance: DAY })
    const days = form({ [futureDay(83)]: DAY })
    const onBehalf = { reason: 'Because', approveNow: true, allowOverdraw: false }

    await refusal(submitLeaveRequest(other, days, { ...onBehalf, employeeId: employee.id }))
    await refusal(submitLeaveRequest(admin, days, { ...onBehalf, employeeId: admin.id }))
  })

  it('refuses a day in a benefit year that has already closed', async () => {
    const admin = await person('closed-admin', { role: 'ADMIN' })
    const employee = await person('closed', { balance: DAY })
    const lastYear = iso(addDays(today, -400))
    const error = await refusal(
      submitLeaveRequest(admin, form({ [lastYear]: DAY }), {
        employeeId: employee.id,
        reason: 'Forgot to record it',
        approveNow: true,
        allowOverdraw: true,
      }),
    )
    expect(error.message).toMatch(/already closed/)
  })
})

describe('an administrator amending a request', () => {
  it('moves approved leave to new days, giving back the old ones in the ledger', async () => {
    const admin = await person('amend-admin', { role: 'ADMIN' })
    const employee = await person('amend', { balance: DAY * 3 })
    const [d1, d2, d3] = [futureDay(20), futureDay(21), futureDay(25)]

    const { id } = await submitLeaveRequest(admin, form({ [d1]: DAY, [d2]: DAY }), {
      employeeId: employee.id,
      reason: 'Booked by phone',
      approveNow: true,
      allowOverdraw: false,
    })
    const later = addDays(today, 400)
    expect(await balanceAsOf(employee.id, leaveTypeId, later)).toBe(DAY)

    await amendLeaveRequest(admin, {
      requestId: id,
      values: form({ [d3]: HALF }),
      reason: 'Only needs the morning of the 25th day',
      allowOverdraw: false,
    })

    const request = await db.leaveRequest.findUniqueOrThrow({
      where: { id },
      select: { status: true, totalMinutes: true, days: { select: { date: true, minutes: true } } },
    })
    expect(request.status).toBe('APPROVED')
    expect(request.totalMinutes).toBe(HALF)
    expect(request.days.map((d) => [iso(d.date), d.minutes])).toEqual([[d3, HALF]])

    expect((await usage(id)).map((e) => [iso(e.effectiveDate), e.kind, e.minutes])).toEqual([
      [d1, 'USAGE', -DAY],
      [d1, 'USAGE_REVERSAL', DAY],
      [d2, 'USAGE', -DAY],
      [d2, 'USAGE_REVERSAL', DAY],
      [d3, 'USAGE', -HALF],
    ])
    expect(await balanceAsOf(employee.id, leaveTypeId, later)).toBe(DAY * 3 - HALF)

    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityId: id, action: 'leaveRequest.override.amend' },
    })
    expect(audit.reason).toBe('Only needs the morning of the 25th day')
  })

  it('judges the new days without the old ones counting against them', async () => {
    const admin = await person('rejudge-admin', { role: 'ADMIN' })
    const employee = await person('rejudge', { balance: DAY })
    const { id } = await submitLeaveRequest(admin, form({ [futureDay(30)]: DAY }), {
      employeeId: employee.id,
      reason: 'Booked by phone',
      approveNow: true,
      allowOverdraw: false,
    })
    // The whole balance is used; moving it to another day must still fit.
    await amendLeaveRequest(admin, {
      requestId: id,
      values: form({ [futureDay(31)]: DAY }),
      reason: 'Moved a day later',
      allowOverdraw: false,
    })
    expect(await balanceAsOf(employee.id, leaveTypeId, addDays(today, 400))).toBe(0)
  })

  it('keeps a pending request in its chain, and is refused to the requester', async () => {
    const admin = await person('pending-amend-admin', { role: 'ADMIN' })
    const approver = await person('pending-amend-approver')
    const employee = await person('pending-amend', { balance: DAY * 2 })
    await chain(employee.id, [approver])

    const { id } = await submitLeaveRequest(employee, form({ [futureDay(35)]: DAY }))
    await refusal(
      amendLeaveRequest(employee, {
        requestId: id,
        values: form({ [futureDay(36)]: DAY }),
        reason: 'Changing my own',
        allowOverdraw: false,
      }),
    )
    await amendLeaveRequest(admin, {
      requestId: id,
      values: form({ [futureDay(36)]: DAY * 1, [futureDay(37)]: DAY }),
      reason: 'Asked to add a day',
      allowOverdraw: false,
    })

    expect(await usage(id)).toEqual([])
    expect((await steps(id))[0].status).toBe('PENDING')
    expect(await decideLeaveRequest(approver, { requestId: id, decision: 'APPROVE' })).toBe(
      'APPROVED',
    )
    expect((await usage(id)).map((e) => e.minutes)).toEqual([-DAY, -DAY])
  })

  it('lets an administrator deny on an approver’s behalf, with a reason', async () => {
    const admin = await person('deny-admin', { role: 'ADMIN' })
    const approver = await person('deny-approver')
    const employee = await person('deny', { balance: DAY })
    await chain(employee.id, [approver])

    const { id } = await submitLeaveRequest(employee, form({ [futureDay(40)]: DAY }))
    expect(
      await decideLeaveRequest(admin, {
        requestId: id,
        decision: 'DENY',
        overrideReason: 'Clashes with the building closure',
      }),
    ).toBe('DENIED')
    expect((await steps(id))[0]).toMatchObject({
      status: 'DENIED',
      decidedById: admin.id,
      comment: 'Clashes with the building closure',
    })
  })
})
