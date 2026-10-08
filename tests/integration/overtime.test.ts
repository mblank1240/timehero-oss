import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { addDays, benefitYearContaining, todayIn } from '@/lib/accrual/dates'
import { db } from '@/lib/db'
import { balanceAsOf } from '@/lib/ledger/balance'
import {
  RequestError,
  cancelOvertimeLog,
  decideOvertimeLog,
  rerouteOvertimeLog,
  submitOvertimeLog,
} from '@/lib/overtime/service'
import type { Actor } from '@/lib/requests/chain'
import { submitLeaveRequest } from '@/lib/requests/service'

/**
 * Overtime logs end to end against real Postgres: logging, the approval
 * chain, banking comp at the multiplier, spending it as leave — and rule 4,
 * that an hourly employee cannot reach comp time by any route.
 *
 * The comp type is made here and the org pointed at it for the run, with the
 * church's shape — nothing carries under the rule, December rescued until the
 * end of February — so the closed-year cases have something to judge
 * against. Everything is namespaced by a run id and torn down afterwards.
 */

const RUN = `otest-${Date.now().toString(36)}`
const DAY = 480

let compTypeId: string
let today: Date
let thisYear: ReturnType<typeof benefitYearContaining>
const employeeIds: string[] = []
let original: {
  compLeaveTypeId: string | null
  compTimeMultiplierBps: number
  compExpiresAfterDays: number | null
}

const iso = (date: Date) => date.toISOString().slice(0, 10)
const dayAt = (value: string) => new Date(`${value}T00:00:00.000Z`)

async function person(
  key: string,
  opts: { role?: 'ADMIN' | 'EMPLOYEE'; type?: 'HOURLY' | 'SALARIED_EXEMPT' } = {},
): Promise<Actor> {
  const employee = await db.employee.create({
    data: {
      email: `${RUN}-${key}@example.test`,
      firstName: RUN,
      lastName: key,
      role: opts.role ?? 'EMPLOYEE',
      employmentType: opts.type ?? 'SALARIED_EXEMPT',
      hireDate: new Date('2015-01-01'),
      standardMinutesPerDay: DAY,
    },
  })
  employeeIds.push(employee.id)
  return { id: employee.id, role: employee.role }
}

async function chain(employeeId: string, approvers: Actor[]) {
  await db.approvalChainStep.createMany({
    data: approvers.map((a, i) => ({ employeeId, step: i + 1, approverId: a.id })),
  })
}

function form(worked: string, date = iso(today), note = 'Easter services') {
  return { date, worked, note }
}

async function earned(logId: string) {
  return db.ledgerEntry.findMany({
    where: { sourceType: 'OvertimeLog', sourceId: logId },
    orderBy: { effectiveDate: 'asc' },
    select: { effectiveDate: true, minutes: true, kind: true, expiresOn: true, leaveTypeId: true },
  })
}

async function log(id: string) {
  return db.overtimeLog.findUniqueOrThrow({
    where: { id },
    select: { status: true, earnedMinutes: true, multiplierBps: true, resolvedAt: true },
  })
}

async function steps(logId: string) {
  return db.approvalStep.findMany({
    where: { overtimeLogId: logId },
    orderBy: { step: 'asc' },
    select: { step: true, approverId: true, status: true, decidedById: true, comment: true },
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

/** A database refusal: the raw error, whatever Prisma wraps it in. */
async function rejected(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(Error)
  return (error as Error).message
}

beforeAll(async () => {
  const org = await db.orgSettings.findUnique({ where: { id: 1 } })
  if (!org) throw new Error('Run `npm run db:seed` before the integration tests.')
  original = {
    compLeaveTypeId: org.compLeaveTypeId,
    compTimeMultiplierBps: org.compTimeMultiplierBps,
    compExpiresAfterDays: org.compExpiresAfterDays,
  }
  // Written against the church's 15-minute timesheet increment.
  expect(org.timesheetIncrementMinutes).toBe(15)

  today = todayIn(org.timezone)
  thisYear = benefitYearContaining(today, org.benefitYearStartMonth, org.benefitYearStartDay)

  const type = await db.leaveType.create({
    data: {
      code: `${RUN}-COMP`,
      name: `${RUN} Comp`,
      countsTowardRollover: false,
      accruableBy: 'EXEMPT_ONLY',
      rolloverRule: { create: { capBasis: 'NONE' } },
      carryoverWindows: {
        create: {
          name: 'December grace',
          earnedFromMonth: 12,
          earnedFromDay: 1,
          earnedToMonth: 12,
          earnedToDay: 31,
          usableUntilMonth: 2,
          usableUntilDay: 28,
        },
      },
    },
  })
  compTypeId = type.id

  await db.orgSettings.update({
    where: { id: 1 },
    data: { compLeaveTypeId: compTypeId, compTimeMultiplierBps: 10_000, compExpiresAfterDays: null },
  })
})

afterAll(async () => {
  await db.orgSettings.update({ where: { id: 1 }, data: original })

  const logs = await db.overtimeLog.findMany({
    where: { employeeId: { in: employeeIds } },
    select: { id: true },
  })
  const requests = await db.leaveRequest.findMany({
    where: { employeeId: { in: employeeIds } },
    select: { id: true },
  })
  await db.auditLog.deleteMany({
    where: { entityId: { in: [...logs, ...requests].map((r) => r.id) } },
  })
  // Logs and requests before employees: a step's approver is onDelete Restrict.
  await db.overtimeLog.deleteMany({ where: { employeeId: { in: employeeIds } } })
  await db.leaveRequest.deleteMany({ where: { employeeId: { in: employeeIds } } })
  await db.ledgerEntry.deleteMany({ where: { leaveTypeId: compTypeId } })
  await db.approvalChainStep.deleteMany({ where: { employeeId: { in: employeeIds } } })
  await db.employee.deleteMany({ where: { id: { in: employeeIds } } })
  await db.leaveType.deleteMany({ where: { id: compTypeId } })
})

describe('banking overtime', () => {
  it('moves a log through a two-step chain and banks it as comp', async () => {
    const [a, b] = [await person('a'), await person('b')]
    const worker = await person('two-step')
    await chain(worker.id, [a, b])

    const { id } = await submitOvertimeLog(worker, form('2h 15m'))
    expect((await steps(id)).map((s) => s.status)).toEqual(['PENDING', 'PENDING'])

    // Out of order: the log is waiting on step 1.
    await refusal(decideOvertimeLog(b, { logId: id, decision: 'APPROVE' }))

    expect(await decideOvertimeLog(a, { logId: id, decision: 'APPROVE' })).toBe('ADVANCED')
    expect(await earned(id)).toEqual([])

    expect(await decideOvertimeLog(b, { logId: id, decision: 'APPROVE', comment: 'Thanks' })).toBe(
      'APPROVED',
    )

    expect(await earned(id)).toEqual([
      { effectiveDate: today, minutes: 135, kind: 'COMP_EARNED', expiresOn: null, leaveTypeId: compTypeId },
    ])
    expect(await log(id)).toMatchObject({
      status: 'APPROVED',
      earnedMinutes: 135,
      multiplierBps: 10_000,
    })
    expect(await balanceAsOf(worker.id, compTypeId, today)).toBe(135)

    const audit = await db.auditLog.findMany({
      where: { entityType: 'OvertimeLog', entityId: id },
      orderBy: { createdAt: 'asc' },
      select: { action: true },
    })
    expect(audit.map((r) => r.action)).toEqual([
      'overtimeLog.submit',
      'overtimeLog.approve',
      'overtimeLog.approve',
    ])

    // Approving twice writes nothing twice.
    await refusal(decideOvertimeLog(b, { logId: id, decision: 'APPROVE' }))
    expect(await earned(id)).toHaveLength(1)
  })

  it('banks at the org multiplier in force at approval, rounding a half-minute up', async () => {
    const approver = await person('mult-approver')
    const worker = await person('mult')
    await chain(worker.id, [approver])

    const { id } = await submitOvertimeLog(worker, form('2:15'))
    await db.orgSettings.update({ where: { id: 1 }, data: { compTimeMultiplierBps: 15_000 } })
    try {
      await decideOvertimeLog(approver, { logId: id, decision: 'APPROVE' })
    } finally {
      await db.orgSettings.update({ where: { id: 1 }, data: { compTimeMultiplierBps: 10_000 } })
    }

    // 135 × 1.5 = 202.5
    expect((await earned(id)).map((e) => e.minutes)).toEqual([203])
    expect(await log(id)).toMatchObject({ earnedMinutes: 203, multiplierBps: 15_000 })
  })

  it('stamps the optional expiry, counted from the day worked', async () => {
    const approver = await person('exp-approver')
    const worker = await person('exp')
    await chain(worker.id, [approver])

    await db.orgSettings.update({ where: { id: 1 }, data: { compExpiresAfterDays: 30 } })
    try {
      const { id } = await submitOvertimeLog(worker, form('1h'))
      await decideOvertimeLog(approver, { logId: id, decision: 'APPROVE' })
      expect((await earned(id))[0].expiresOn).toEqual(addDays(today, 30))
    } finally {
      await db.orgSettings.update({ where: { id: 1 }, data: { compExpiresAfterDays: null } })
    }
  })

  /**
   * Worked ten days ago under a five-day expiry: the comp ran out five days
   * ago, before anyone approved it. Banking it would grant time the expiry
   * job forfeits the same night, so approval refuses and leaves the step
   * pending for the approver to deny.
   */
  it('refuses to bank comp that expired before it was approved', async () => {
    const approver = await person('expired-approver')
    const worker = await person('expired')
    await chain(worker.id, [approver])

    const worked = addDays(today, -10)
    const { id } = await submitOvertimeLog(worker, form('1h', iso(worked)))

    await db.orgSettings.update({ where: { id: 1 }, data: { compExpiresAfterDays: 5 } })
    try {
      const error = await refusal(decideOvertimeLog(approver, { logId: id, decision: 'APPROVE' }))
      expect(error.message).toContain(`expired on ${iso(addDays(worked, 5))}`)
    } finally {
      await db.orgSettings.update({ where: { id: 1 }, data: { compExpiresAfterDays: null } })
    }

    expect(await earned(id)).toEqual([])
    expect((await log(id)).status).toBe('PENDING')
    expect((await steps(id)).map((s) => s.status)).toEqual(['PENDING'])

    // Denying it still works.
    expect(await decideOvertimeLog(approver, { logId: id, decision: 'DENY' })).toBe('DENIED')
  })

  it('is spendable as an ordinary leave request against the comp type', async () => {
    const approver = await person('spend-approver')
    const worker = await person('spend')
    await chain(worker.id, [approver])

    const { id } = await submitOvertimeLog(worker, form('4h'))
    await decideOvertimeLog(approver, { logId: id, decision: 'APPROVE' })

    // The next working day after today that is in this benefit year.
    let day = addDays(today, 1)
    while ([0, 6].includes(day.getUTCDay())) day = addDays(day, 1)
    if (day > thisYear.end) return // too close to the rollover to book against this year's comp

    const request = await submitLeaveRequest(worker, {
      leaveTypeId: compTypeId,
      days: [{ date: iso(day), minutes: '240' }],
    })
    expect(request.status).toBe('PENDING')

    // And no more than was banked.
    const over = await refusal(
      submitLeaveRequest(worker, {
        leaveTypeId: compTypeId,
        days: [{ date: iso(addDays(day, 7)), minutes: '240' }],
      }),
    )
    expect(over.message).toMatch(/not enough time/)
  })
})

describe('the approval chain', () => {
  it('ends at a denial, closing the later steps and banking nothing', async () => {
    const [a, b] = [await person('deny-a'), await person('deny-b')]
    const worker = await person('deny')
    await chain(worker.id, [a, b])

    const { id } = await submitOvertimeLog(worker, form('1h'))
    expect(await decideOvertimeLog(a, { logId: id, decision: 'DENY' })).toBe('DENIED')

    expect((await steps(id)).map((s) => s.status)).toEqual(['DENIED', 'SKIPPED'])
    expect((await log(id)).status).toBe('DENIED')
    expect(await earned(id)).toEqual([])
  })

  it('goes to any administrator when the chain is empty, never to the worker', async () => {
    const admin = await person('admin', { role: 'ADMIN' })
    const worker = await person('no-chain', { role: 'ADMIN' })

    const { id } = await submitOvertimeLog(worker, form('30m'))
    expect(await steps(id)).toMatchObject([{ step: 1, approverId: null, status: 'PENDING' }])

    const own = await refusal(decideOvertimeLog(worker, { logId: id, decision: 'APPROVE' }))
    expect(own.message).toMatch(/your own/)
    await refusal(
      decideOvertimeLog(worker, { logId: id, decision: 'APPROVE', overrideReason: 'my own' }),
    )

    expect(await decideOvertimeLog(admin, { logId: id, decision: 'APPROVE' })).toBe('APPROVED')
  })

  it('skips the worker in their own chain', async () => {
    const other = await person('self-other')
    const worker = await person('self')
    await chain(worker.id, [worker, other])

    const { id } = await submitOvertimeLog(worker, form('30m'))
    expect((await steps(id)).map((s) => s.status)).toEqual(['SKIPPED', 'PENDING'])
  })

  it('refuses a self-decided step at the database, whatever the code does', async () => {
    const approver = await person('db-self-approver')
    const worker = await person('db-self')
    await chain(worker.id, [approver])
    const { id } = await submitOvertimeLog(worker, form('30m'))

    const message = await rejected(
      db.approvalStep.updateMany({
        where: { overtimeLogId: id, step: 1 },
        data: { status: 'APPROVED', decidedById: worker.id, decidedAt: new Date() },
      }),
    )
    expect(message).toMatch(/may not decide their own overtime log/)
  })

  it('lets an administrator approve, skip and reroute — each with a reason', async () => {
    const admin = await person('ovr-admin', { role: 'ADMIN' })
    const [a, b, c] = [await person('ovr-a'), await person('ovr-b'), await person('ovr-c')]
    const worker = await person('ovr')
    await chain(worker.id, [a, b])

    const { id } = await submitOvertimeLog(worker, form('1h'))

    await refusal(rerouteOvertimeLog(a, { logId: id, approverId: c.id, reason: 'not admin' }))
    await rerouteOvertimeLog(admin, { logId: id, approverId: c.id, reason: 'A is on sabbatical' })
    expect((await steps(id))[0].approverId).toBe(c.id)

    await decideOvertimeLog(admin, { logId: id, decision: 'SKIP', overrideReason: 'Covered by C' })
    expect(
      await decideOvertimeLog(admin, {
        logId: id,
        decision: 'APPROVE',
        overrideReason: 'B confirmed by phone',
      }),
    ).toBe('APPROVED')

    expect(await steps(id)).toMatchObject([
      { status: 'SKIPPED', decidedById: admin.id, comment: 'Covered by C' },
      { status: 'APPROVED', decidedById: admin.id, comment: 'B confirmed by phone' },
    ])
    expect((await earned(id)).map((e) => e.minutes)).toEqual([60])
  })

  it('can be cancelled by the worker while pending, and not once approved', async () => {
    const approver = await person('cancel-approver')
    const admin = await person('cancel-admin', { role: 'ADMIN' })
    const worker = await person('cancel')
    await chain(worker.id, [approver])

    const pending = await submitOvertimeLog(worker, form('1h'))
    await refusal(cancelOvertimeLog(approver, { logId: pending.id }))
    await refusal(cancelOvertimeLog(admin, { logId: pending.id }))
    await cancelOvertimeLog(worker, { logId: pending.id })
    expect((await log(pending.id)).status).toBe('CANCELLED')
    expect((await steps(pending.id))[0].status).toBe('SKIPPED')

    // A cancelled day can be logged again.
    const again = await submitOvertimeLog(worker, form('1h'))
    await decideOvertimeLog(approver, { logId: again.id, decision: 'APPROVE' })
    const approved = await refusal(cancelOvertimeLog(worker, { logId: again.id }))
    expect(approved.message).toMatch(/administrator/)
  })

  it('lets another administrator cancel approved overtime, taking the comp back', async () => {
    const approver = await person('takeback-approver')
    const admin = await person('takeback-admin', { role: 'ADMIN' })
    const worker = await person('takeback')
    await chain(worker.id, [approver])

    const { id } = await submitOvertimeLog(worker, form('2h'))
    await decideOvertimeLog(approver, { logId: id, decision: 'APPROVE' })
    const banked = (await earned(id))[0]
    expect(banked.kind).toBe('COMP_EARNED')

    await refusal(cancelOvertimeLog(approver, { logId: id, reason: 'Not mine to cancel' }))
    await refusal(cancelOvertimeLog(admin, { logId: id }))
    await cancelOvertimeLog(admin, { logId: id, reason: 'Logged on the wrong day' })

    expect(await log(id)).toMatchObject({
      status: 'CANCELLED',
      earnedMinutes: null,
      multiplierBps: null,
    })
    const entries = await earned(id)
    expect(entries.map((e) => [e.kind, e.minutes])).toEqual([
      ['COMP_EARNED', banked.minutes],
      ['ADJUSTMENT', -banked.minutes],
    ])
    expect(entries.reduce((sum, e) => sum + e.minutes, 0)).toBe(0)

    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityId: id, action: 'overtimeLog.override.cancel' },
    })
    expect(audit.reason).toBe('Logged on the wrong day')
  })
})

describe('what a log may record', () => {
  it('is time worked in timesheet increments, not leave increments', async () => {
    const worker = await person('increments')

    const odd = await refusal(submitOvertimeLog(worker, form('1h 10m')))
    expect(odd.fieldErrors?.worked?.[0]).toMatch(/steps of 15 minutes/)

    await refusal(submitOvertimeLog(worker, form('0')))
    await refusal(submitOvertimeLog(worker, form('soon')))
    await refusal(submitOvertimeLog(worker, form('25h')))

    // A quarter hour is fine: overtime is not held to the half-day leave increment.
    await submitOvertimeLog(worker, form('15m'))
  })

  it('needs a note, a worked date no later than today, and one log a day', async () => {
    const worker = await person('dates')

    const noNote = await refusal(submitOvertimeLog(worker, form('1h', iso(today), '  ')))
    expect(noNote.fieldErrors?.note).toBeDefined()

    const future = await refusal(submitOvertimeLog(worker, form('1h', iso(addDays(today, 1)))))
    expect(future.fieldErrors?.date).toBeDefined()

    const yesterday = iso(addDays(today, -1))
    await submitOvertimeLog(worker, form('1h', yesterday))
    const twice = await refusal(submitOvertimeLog(worker, form('30m', yesterday)))
    expect(twice.message).toMatch(/already logged/)
  })

  it('reaches back no further than the start of the previous benefit year', async () => {
    const worker = await person('too-old')
    const previousStart = benefitYearContaining(addDays(thisYear.start, -1), 1, 1).start

    const old = await refusal(submitOvertimeLog(worker, form('1h', iso(addDays(previousStart, -1)))))
    expect(old.fieldErrors?.date).toBeDefined()
  })

  it('is refused when overtime logging is switched off', async () => {
    const worker = await person('off')
    await db.orgSettings.update({ where: { id: 1 }, data: { compLeaveTypeId: null } })
    try {
      const off = await refusal(submitOvertimeLog(worker, form('1h')))
      expect(off.message).toMatch(/switched off/)
    } finally {
      await db.orgSettings.update({ where: { id: 1 }, data: { compLeaveTypeId: compTypeId } })
    }
  })
})

describe('rule 4: an hourly employee cannot reach comp time by any route', () => {
  it('cannot submit an overtime log', async () => {
    const hourly = await person('hourly', { type: 'HOURLY' })
    const error = await refusal(submitOvertimeLog(hourly, form('1h')))
    expect(error.message).toMatch(/salaried exempt/)
    expect(await db.overtimeLog.count({ where: { employeeId: hourly.id } })).toBe(0)
  })

  it('cannot have an overtime log written for them directly', async () => {
    const hourly = await person('hourly-db', { type: 'HOURLY' })
    const message = await rejected(
      db.overtimeLog.create({
        data: { employeeId: hourly.id, date: today, minutes: 60, note: 'direct write' },
      }),
    )
    expect(message).toMatch(/restricted to SALARIED_EXEMPT/)
  })

  it('cannot have a COMP_EARNED entry written for them directly', async () => {
    const hourly = await person('hourly-ledger', { type: 'HOURLY' })
    const message = await rejected(
      db.ledgerEntry.create({
        data: {
          employeeId: hourly.id,
          leaveTypeId: compTypeId,
          effectiveDate: today,
          minutes: 60,
          kind: 'COMP_EARNED',
        },
      }),
    )
    expect(message).toMatch(/restricted to SALARIED_EXEMPT/)
  })

  it('banks nothing for someone who became hourly while their log was pending', async () => {
    const approver = await person('switch-approver')
    const worker = await person('switch')
    await chain(worker.id, [approver])
    const { id } = await submitOvertimeLog(worker, form('2h'))

    await db.employee.update({ where: { id: worker.id }, data: { employmentType: 'HOURLY' } })

    const error = await refusal(decideOvertimeLog(approver, { logId: id, decision: 'APPROVE' }))
    expect(error.message).toMatch(/no longer salaried exempt/)
    // Rolled back whole: the step is still waiting and nothing was banked.
    expect((await steps(id))[0].status).toBe('PENDING')
    expect(await earned(id)).toEqual([])

    // The database refuses the approval too, had the service not.
    const message = await rejected(
      db.overtimeLog.update({
        where: { id },
        data: { status: 'APPROVED', resolvedAt: new Date(), earnedMinutes: 120, multiplierBps: 10_000 },
      }),
    )
    expect(message).toMatch(/restricted to SALARIED_EXEMPT/)

    // A denial is still possible, which is what should happen to it.
    expect(await decideOvertimeLog(approver, { logId: id, decision: 'DENY' })).toBe('DENIED')
  })

  it('cannot spend comp time as leave', async () => {
    const hourly = await person('hourly-spend', { type: 'HOURLY' })
    const error = await refusal(
      submitLeaveRequest(hourly, {
        leaveTypeId: compTypeId,
        days: [{ date: iso(addDays(today, 3)), minutes: '240' }],
      }),
    )
    expect(error.message).toMatch(/not available to you/)
  })
})

describe('a log approved after its benefit year has closed', () => {
  const lastYear = () => thisYear.start.getUTCFullYear() - 1

  /**
   * The window is stretched to the end of this year for the test, so the
   * carried comp is still spendable on whatever day the suite runs; with the
   * church's 28 February it would be refused from March on (below).
   */
  it('banks December overtime on the new year’s first day, with the window’s expiry', async () => {
    const approver = await person('dec-approver')
    const worker = await person('dec')
    await chain(worker.id, [approver])

    const { id } = await submitOvertimeLog(worker, form('3h', `${lastYear()}-12-20`))
    await db.carryoverWindow.updateMany({
      where: { leaveTypeId: compTypeId },
      data: { usableUntilMonth: 12, usableUntilDay: 31 },
    })
    try {
      await decideOvertimeLog(approver, { logId: id, decision: 'APPROVE' })
    } finally {
      await db.carryoverWindow.updateMany({
        where: { leaveTypeId: compTypeId },
        data: { usableUntilMonth: 2, usableUntilDay: 28 },
      })
    }

    expect(await earned(id)).toEqual([
      {
        effectiveDate: thisYear.start,
        minutes: 180,
        kind: 'COMP_EARNED',
        expiresOn: thisYear.end,
        leaveTypeId: compTypeId,
      },
    ])
  })

  it('refuses December overtime once the window it would carry under has closed', async (ctx) => {
    // Only meaningful from March on; in January and February the window is
    // still open and the comp is banked, as above.
    if (today <= dayAt(`${thisYear.start.getUTCFullYear()}-02-28`)) ctx.skip()

    const approver = await person('dec-late-approver')
    const worker = await person('dec-late')
    await chain(worker.id, [approver])

    const { id } = await submitOvertimeLog(worker, form('3h', `${lastYear()}-12-21`))
    const error = await refusal(decideOvertimeLog(approver, { logId: id, decision: 'APPROVE' }))
    expect(error.message).toMatch(/expired on \d{4}-02-28/)
    expect(await earned(id)).toEqual([])
    expect((await log(id)).status).toBe('PENDING')
  })

  it('banks nothing for November overtime, which the rollover would have forfeited', async () => {
    const approver = await person('nov-approver')
    const worker = await person('nov')
    await chain(worker.id, [approver])

    const { id } = await submitOvertimeLog(worker, form('3h', `${lastYear()}-11-20`))
    expect(await decideOvertimeLog(approver, { logId: id, decision: 'APPROVE' })).toBe('APPROVED')

    expect(await earned(id)).toEqual([])
    expect(await log(id)).toMatchObject({ status: 'APPROVED', earnedMinutes: 0 })
  })
})
