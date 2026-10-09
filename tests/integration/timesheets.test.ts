import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db } from '@/lib/db'
import { runCreateTimesheets } from '@/lib/jobs/timesheets'
import { syncPayPeriodsFor } from '@/lib/payperiods/sync'
import type { Actor } from '@/lib/requests/chain'
import { firstSubmissions, gridFor, sheetHead } from '@/lib/timesheets/data'
import { periodReport } from '@/lib/timesheets/report'
import {
  RequestError,
  decideTimesheet,
  rerouteTimesheet,
  saveTimesheet,
  unlockTimesheet,
  withdrawTimesheet,
} from '@/lib/timesheets/service'

import { accessRoleId, permissionsFor } from './legacy-roles'

/**
 * Timesheets end to end against real Postgres: the creation job, filling one
 * in, freezing leave and holidays at submission, the approval chain round a
 * rejection and back, an administrator's unlock, overtime across a workweek
 * that straddles two timesheets — and the database refusing what the service
 * already refuses.
 *
 * Everything lives on a pay schedule made for the run, in 2031, so no seeded
 * period, holiday or timesheet is in the way. Torn down afterwards.
 */

const RUN = `tstest-${Date.now().toString(36)}`

// Two biweekly periods, each Wednesday to the second Tuesday. The Sunday
// workweek of 16-22 March straddles them.
const P1 = { start: '2031-03-05', end: '2031-03-18' }
const P2 = { start: '2031-03-19', end: '2031-04-01' }
const HOLIDAY = '2031-03-10'

const dayAt = (value: string) => new Date(`${value}T00:00:00.000Z`)

let scheduleId: string
let period1: string
let period2: string
let holidayId: string
let ptoTypeId: string
const employeeIds: string[] = []
let original: {
  workweekStartDay: number
  overtimeWeeklyThresholdMinutes: number
  timesheetDueDaysAfterPeriodEnd: number
}

let worker: Actor
let partTimer: Actor
let exempt: Actor
let approver1: Actor
let approver2: Actor
let admin: Actor
let finance: Actor

async function person(
  key: string,
  opts: {
    role?: 'ADMIN' | 'EMPLOYEE' | 'FINANCE'
    type?: 'HOURLY' | 'SALARIED_EXEMPT'
    day?: number
    hireDate?: string
    terminationDate?: string
  } = {},
): Promise<Actor> {
  const employee = await db.employee.create({
    data: {
      email: `${RUN}-${key}@example.test`,
      firstName: RUN,
      lastName: key,
      role: opts.role ?? 'EMPLOYEE',
      accessRoleId: await accessRoleId(opts.role),
      employmentType: opts.type ?? 'HOURLY',
      hireDate: dayAt(opts.hireDate ?? '2020-01-01'),
      terminationDate: opts.terminationDate ? dayAt(opts.terminationDate) : null,
      standardMinutesPerDay: opts.day ?? 480,
      payScheduleId: scheduleId,
    },
  })
  employeeIds.push(employee.id)
  return { id: employee.id, permissions: await permissionsFor(opts.role) }
}

async function sheetOf(employee: Actor, payPeriodId: string) {
  return db.timesheet.findUniqueOrThrow({
    where: { employeeId_payPeriodId: { employeeId: employee.id, payPeriodId } },
    select: { id: true, status: true, submittedAt: true, resolvedAt: true },
  })
}

async function stepsOf(timesheetId: string) {
  return db.approvalStep.findMany({
    where: { timesheetId },
    orderBy: { step: 'asc' },
    select: { step: true, approverId: true, status: true, comment: true },
  })
}

async function grid(timesheetId: string) {
  const head = await sheetHead(timesheetId)
  return gridFor(head!)
}

async function refusal(promise: Promise<unknown>): Promise<RequestError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(RequestError)
  return error as RequestError
}

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
    workweekStartDay: org.workweekStartDay,
    overtimeWeeklyThresholdMinutes: org.overtimeWeeklyThresholdMinutes,
    timesheetDueDaysAfterPeriodEnd: org.timesheetDueDaysAfterPeriodEnd,
  }
  // Written against the church's 15-minute timesheet increment.
  expect(org.timesheetIncrementMinutes).toBe(15)
  await db.orgSettings.update({
    where: { id: 1 },
    data: {
      workweekStartDay: 7,
      overtimeWeeklyThresholdMinutes: 2400,
      timesheetDueDaysAfterPeriodEnd: 3,
    },
  })

  const schedule = await db.paySchedule.create({
    data: {
      name: RUN,
      type: 'BIWEEKLY',
      anchorDate: dayAt(P1.start),
      payDateOffsetDays: 3,
    },
  })
  scheduleId = schedule.id
  // From well before the periods, so every one of them is in the future and
  // a schedule change would be free to redraw it.
  await syncPayPeriodsFor(scheduleId, {
    actorId: null,
    asOf: dayAt('2031-01-01'),
  })
  period1 = (
    await db.payPeriod.findUniqueOrThrow({
      where: {
        payScheduleId_startDate: {
          payScheduleId: scheduleId,
          startDate: dayAt(P1.start),
        },
      },
    })
  ).id
  period2 = (
    await db.payPeriod.findUniqueOrThrow({
      where: {
        payScheduleId_startDate: {
          payScheduleId: scheduleId,
          startDate: dayAt(P2.start),
        },
      },
    })
  ).id

  holidayId = (
    await db.holiday.create({
      data: { date: dayAt(HOLIDAY), name: `${RUN} holiday`, minutes: 480 },
    })
  ).id
  ptoTypeId = (await db.leaveType.findUniqueOrThrow({ where: { code: 'PTO' } })).id

  worker = await person('worker')
  partTimer = await person('parttime', { day: 240 })
  exempt = await person('exempt', { type: 'SALARIED_EXEMPT' })
  await person('later-hire', { hireDate: '2031-04-02' })
  await person('gone', { terminationDate: '2031-03-01' })
  approver1 = await person('approver1', { type: 'SALARIED_EXEMPT' })
  approver2 = await person('approver2', { type: 'SALARIED_EXEMPT' })
  admin = await person('admin', { role: 'ADMIN', type: 'SALARIED_EXEMPT' })
  finance = await person('finance', {
    role: 'FINANCE',
    type: 'SALARIED_EXEMPT',
  })

  await db.approvalChainStep.createMany({
    data: [
      { employeeId: worker.id, step: 1, approverId: approver1.id },
      { employeeId: worker.id, step: 2, approverId: approver2.id },
    ],
  })
})

afterAll(async () => {
  await db.orgSettings.update({ where: { id: 1 }, data: original })

  const sheets = await db.timesheet.findMany({
    where: { employeeId: { in: employeeIds } },
    select: { id: true },
  })
  await db.auditLog.deleteMany({
    where: { entityId: { in: sheets.map((s) => s.id) } },
  })
  // Before employees: a step's approver is onDelete Restrict.
  await db.timesheet.deleteMany({ where: { employeeId: { in: employeeIds } } })
  await db.leaveRequest.deleteMany({
    where: { employeeId: { in: employeeIds } },
  })
  await db.approvalChainStep.deleteMany({
    where: { employeeId: { in: employeeIds } },
  })
  await db.employee.deleteMany({ where: { id: { in: employeeIds } } })
  await db.holiday.delete({ where: { id: holidayId } })
  await db.auditLog.deleteMany({ where: { entityId: scheduleId } })
  await db.payPeriod.deleteMany({ where: { payScheduleId: scheduleId } })
  await db.paySchedule.delete({ where: { id: scheduleId } })
})

describe('the create-timesheets job', () => {
  it('creates one per hourly employee in the open period, and nothing on a re-run', async () => {
    const first = await runCreateTimesheets(dayAt('2031-03-10'))
    const ours = await db.timesheet.findMany({
      where: { employeeId: { in: employeeIds } },
      select: { employeeId: true, payPeriodId: true, status: true },
    })

    // The worker and the part-timer. Not the exempt staff, not someone hired
    // after the period, not someone who left before it.
    expect(ours).toHaveLength(2)
    expect(new Set(ours.map((s) => s.employeeId))).toEqual(new Set([worker.id, partTimer.id]))
    expect(ours.some((s) => s.employeeId === exempt.id)).toBe(false)
    expect(ours.every((s) => s.payPeriodId === period1 && s.status === 'OPEN')).toBe(true)
    expect(first.entriesCreated).toBeGreaterThanOrEqual(2)

    const again = await runCreateTimesheets(dayAt('2031-03-10'))
    expect(again.entriesCreated).toBe(0)
    expect(await db.timesheet.count({ where: { employeeId: { in: employeeIds } } })).toBe(2)

    // The next period's, on a day inside it.
    await runCreateTimesheets(dayAt(P2.start))
    expect(await db.timesheet.count({ where: { employeeId: { in: employeeIds } } })).toBe(4)
  })

  it('leaves a period that has timesheets where it is when the schedule moves', async () => {
    await db.paySchedule.update({
      where: { id: scheduleId },
      data: { anchorDate: dayAt('2031-03-06') },
    })
    await syncPayPeriodsFor(scheduleId, {
      actorId: null,
      asOf: dayAt('2031-01-01'),
    })

    const p1 = await db.payPeriod.findUnique({ where: { id: period1 } })
    expect(p1?.startDate).toEqual(dayAt(P1.start))
    expect(p1?.endDate).toEqual(dayAt(P1.end))

    await db.paySchedule.update({
      where: { id: scheduleId },
      data: { anchorDate: dayAt(P1.start) },
    })
    await syncPayPeriodsFor(scheduleId, {
      actorId: null,
      asOf: dayAt('2031-01-01'),
    })
  })
})

describe('filling in and submitting', () => {
  it('saves only the employee’s own timesheet, in the timesheet increment', async () => {
    const { id } = await sheetOf(worker, period1)

    const other = await refusal(
      saveTimesheet(approver1, {
        timesheetId: id,
        values: { 'worked-2031-03-05': '8' },
      }),
    )
    expect(other.message).toMatch(/your own/)

    const bad = await refusal(
      saveTimesheet(worker, {
        timesheetId: id,
        values: { 'worked-2031-03-05': '7h 10m' },
      }),
    )
    expect(bad.fieldErrors?.['worked-2031-03-05']?.[0]).toMatch(/steps of 15 minutes/)

    await saveTimesheet(worker, {
      timesheetId: id,
      values: {
        'worked-2031-03-05': '8h',
        'worked-2031-03-06': '7:45',
        'note-2031-03-06': 'Left early for the dentist',
        // Monday to Wednesday of the straddling week: 30 hours.
        'worked-2031-03-16': '10',
        'worked-2031-03-17': '10',
        'worked-2031-03-18': '10',
      },
    })

    const g = await grid(id)
    expect(g.totals.worked).toBe(480 + 465 + 1800)
    expect(g.days.find((d) => d.iso === '2031-03-06')?.note).toBe('Left early for the dentist')

    // Saving again replaces rather than adds.
    await saveTimesheet(worker, {
      timesheetId: id,
      values: {
        'worked-2031-03-05': '8h',
        'worked-2031-03-16': '10',
        'worked-2031-03-17': '10',
        'worked-2031-03-18': '10',
      },
    })
    expect((await grid(id)).totals.worked).toBe(480 + 1800)
  })

  it('shows approved leave and holidays live while open, at the employee’s own day', async () => {
    const { id } = await sheetOf(partTimer, period1)
    await db.leaveRequest.create({
      data: {
        employeeId: partTimer.id,
        leaveTypeId: ptoTypeId,
        status: 'APPROVED',
        totalMinutes: 240,
        submittedAt: new Date(),
        resolvedAt: new Date(),
        days: { create: [{ date: dayAt('2031-03-12'), minutes: 240 }] },
      },
    })

    const g = await grid(id)
    expect(g.totals.holiday).toBe(240)
    expect(g.totals.leave).toBe(240)
    expect(g.days.find((d) => d.iso === HOLIDAY)?.holiday?.minutes).toBe(240)
  })

  it('freezes leave and holidays at submission and snapshots the chain', async () => {
    const { id } = await sheetOf(partTimer, period1)
    await saveTimesheet(partTimer, {
      timesheetId: id,
      values: { 'worked-2031-03-05': '4h' },
      submit: true,
    })

    const entries = await db.timeEntry.findMany({
      where: { timesheetId: id },
      select: { category: true, minutes: true, date: true, leaveTypeId: true },
      orderBy: [{ date: 'asc' }],
    })
    expect(entries.map((e) => [e.category, e.minutes])).toEqual([
      ['REGULAR', 240],
      ['HOLIDAY', 240],
      ['LEAVE', 240],
    ])

    // No chain: one step open to any administrator.
    expect(await stepsOf(id)).toEqual([
      { step: 1, approverId: null, status: 'PENDING', comment: null },
    ])

    // Leave approved after submission does not reach a submitted timesheet.
    await db.leaveRequest.create({
      data: {
        employeeId: partTimer.id,
        leaveTypeId: ptoTypeId,
        status: 'APPROVED',
        totalMinutes: 240,
        submittedAt: new Date(),
        resolvedAt: new Date(),
        days: { create: [{ date: dayAt('2031-03-13'), minutes: 240 }] },
      },
    })
    expect((await grid(id)).totals.leave).toBe(240)
  })

  it('cannot be edited once submitted, by the service or around it', async () => {
    const { id } = await sheetOf(partTimer, period1)

    const save = await refusal(
      saveTimesheet(partTimer, {
        timesheetId: id,
        values: { 'worked-2031-03-06': '4' },
      }),
    )
    expect(save.message).toMatch(/submitted/)

    expect(
      await rejected(
        db.timeEntry.create({
          data: {
            timesheetId: id,
            date: dayAt('2031-03-06'),
            minutes: 60,
            category: 'REGULAR',
          },
        }),
      ),
    ).toMatch(/cannot be changed/)
    expect(await rejected(db.timeEntry.deleteMany({ where: { timesheetId: id } }))).toMatch(
      /cannot be changed/,
    )
  })

  it('can be withdrawn by the employee and edited again', async () => {
    const { id } = await sheetOf(partTimer, period1)
    await withdrawTimesheet(partTimer, { timesheetId: id })

    expect((await sheetOf(partTimer, period1)).status).toBe('OPEN')
    expect((await stepsOf(id))[0]).toMatchObject({ status: 'SKIPPED' })
    // Live again: the later leave now shows.
    expect((await grid(id)).totals.leave).toBe(480)
  })
})

describe('approval', () => {
  it('goes back to the employee on a rejection and round the chain again', async () => {
    const { id } = await sheetOf(worker, period1)
    await saveTimesheet(worker, {
      timesheetId: id,
      values: {
        'worked-2031-03-05': '8h',
        'worked-2031-03-16': '10',
        'worked-2031-03-17': '10',
        'worked-2031-03-18': '10',
      },
      submit: true,
    })

    const notYet = await refusal(
      decideTimesheet(approver2, { timesheetId: id, decision: 'APPROVE' }),
    )
    expect(notYet.message).toMatch(/not waiting on you/)
    const self = await refusal(decideTimesheet(worker, { timesheetId: id, decision: 'APPROVE' }))
    expect(self.message).toMatch(/your own/)

    expect(
      await decideTimesheet(approver1, {
        timesheetId: id,
        decision: 'DENY',
        comment: 'The 6th is missing',
      }),
    ).toBe('DENIED')

    const sentBack = await sheetOf(worker, period1)
    expect(sentBack.status).toBe('REJECTED')
    expect(sentBack.resolvedAt).not.toBeNull()
    expect((await stepsOf(id)).map((s) => s.status)).toEqual(['DENIED', 'SKIPPED'])

    await saveTimesheet(worker, {
      timesheetId: id,
      values: {
        'worked-2031-03-05': '8h',
        'worked-2031-03-06': '8h',
        'worked-2031-03-16': '10',
        'worked-2031-03-17': '10',
        'worked-2031-03-18': '10',
      },
      submit: true,
    })

    // The first round's steps stay; the second is numbered after them.
    expect((await stepsOf(id)).map((s) => [s.step, s.status])).toEqual([
      [1, 'DENIED'],
      [2, 'SKIPPED'],
      [3, 'PENDING'],
      [4, 'PENDING'],
    ])
    expect((await sheetOf(worker, period1)).resolvedAt).toBeNull()

    expect(
      await decideTimesheet(approver1, {
        timesheetId: id,
        decision: 'APPROVE',
      }),
    ).toBe('ADVANCED')
    expect(
      await decideTimesheet(approver2, {
        timesheetId: id,
        decision: 'APPROVE',
      }),
    ).toBe('APPROVED')
    expect((await sheetOf(worker, period1)).status).toBe('APPROVED')

    const locked = await refusal(
      saveTimesheet(worker, {
        timesheetId: id,
        values: { 'worked-2031-03-07': '8' },
      }),
    )
    expect(locked.message).toMatch(/locked/)
  })

  it('refuses a self-decided step in the database as well', async () => {
    const { id } = await sheetOf(worker, period2)
    await saveTimesheet(worker, { timesheetId: id, values: {}, submit: true })
    const step = await db.approvalStep.findFirstOrThrow({
      where: { timesheetId: id, status: 'PENDING' },
    })
    expect(
      await rejected(
        db.approvalStep.update({
          where: { id: step.id },
          data: {
            status: 'APPROVED',
            decidedById: worker.id,
            decidedAt: new Date(),
          },
        }),
      ),
    ).toMatch(/may not decide their own timesheet/)

    // Rerouted by an administrator, and the new approver can act.
    await rerouteTimesheet(admin, {
      timesheetId: id,
      approverId: approver2.id,
      reason: 'Approver 1 is away this week',
    })
    expect((await stepsOf(id))[0].approverId).toBe(approver2.id)
    await withdrawTimesheet(worker, { timesheetId: id })
  })

  it('is judged late or on time by its first submission, not its resubmission', async () => {
    const { id } = await sheetOf(worker, period1)
    const steps = await db.approvalStep.findMany({
      where: { timesheetId: id },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    })
    expect((await firstSubmissions([id])).get(id)).toEqual(steps[0].createdAt)
    expect((await firstSubmissions([])).size).toBe(0)
  })

  it('cannot be decided, overridden or unlocked by finance', async () => {
    const { id } = await sheetOf(worker, period1)
    expect(
      (await refusal(unlockTimesheet(finance, { timesheetId: id, reason: 'Payroll fix' }))).message,
    ).toMatch(/administrator/)

    const second = await sheetOf(worker, period2)
    await saveTimesheet(worker, {
      timesheetId: second.id,
      values: {},
      submit: true,
    })
    expect(
      (
        await refusal(
          decideTimesheet(finance, {
            timesheetId: second.id,
            decision: 'APPROVE',
            overrideReason: 'Payroll',
          }),
        )
      ).message,
    ).toMatch(/administrator/)
    expect(
      (
        await refusal(
          decideTimesheet(finance, {
            timesheetId: second.id,
            decision: 'APPROVE',
          }),
        )
      ).message,
    ).toMatch(/not waiting on you/)
    await withdrawTimesheet(worker, { timesheetId: second.id })
  })

  it('is unlocked only by another administrator, with the reason audited', async () => {
    const { id } = await sheetOf(worker, period1)

    expect(
      (await refusal(unlockTimesheet(approver1, { timesheetId: id, reason: 'Fix it' }))).message,
    ).toMatch(/administrator/)

    await unlockTimesheet(admin, {
      timesheetId: id,
      reason: 'Wrong hours on the 6th',
    })

    const reopened = await sheetOf(worker, period1)
    expect(reopened.status).toBe('OPEN')
    expect(reopened.resolvedAt).toBeNull()
    expect(reopened.submittedAt).not.toBeNull()

    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityId: id, action: 'timesheet.unlock' },
    })
    expect(audit).toMatchObject({
      actorId: admin.id,
      reason: 'Wrong hours on the 6th',
    })

    const again = await refusal(unlockTimesheet(admin, { timesheetId: id, reason: 'Again please' }))
    expect(again.message).toMatch(/already open/)
  })
})

describe('overtime across two timesheets', () => {
  it('counts the earlier timesheet’s days toward the straddling week, without changing them', async () => {
    const first = await sheetOf(worker, period1)
    const second = await sheetOf(worker, period2)

    // Thursday and Friday of the week that began on Sunday 16 March: 30
    // hours already on the first timesheet, so 10 more reaches 40 and the
    // rest is overtime — on the second timesheet's days.
    await saveTimesheet(worker, {
      timesheetId: second.id,
      values: {
        'worked-2031-03-19': '10',
        'worked-2031-03-20': '6',
        'worked-2031-03-24': '8',
      },
    })

    const g2 = await grid(second.id)
    expect(g2.days.find((d) => d.iso === '2031-03-19')?.overtime).toBe(0)
    expect(g2.days.find((d) => d.iso === '2031-03-20')?.overtime).toBe(360)
    expect(g2.days.find((d) => d.iso === '2031-03-24')?.overtime).toBe(0)
    expect(g2.totals).toMatchObject({
      worked: 1440,
      overtime: 360,
      regular: 1080,
    })

    const g1 = await grid(first.id)
    expect(g1.totals.overtime).toBe(0)
  })

  it('reports every timesheet in the period, with the same totals', async () => {
    // Long after the period: due on 4 April 2031, three days after it ended.
    const report = await periodReport(period2, new Date('2031-06-01T12:00:00Z'))
    expect(report!.dueDate).toEqual(dayAt('2031-04-04'))
    const ours = report!.rows.filter((r) => employeeIds.includes(r.employee.id))
    expect(ours.map((r) => [r.employee.lastName, r.status, r.timeliness])).toEqual([
      ['parttime', 'OPEN', 'OVERDUE'],
      // Submitted today, in 2026: well before 2031's due date.
      ['worker', 'OPEN', 'ON_TIME'],
    ])
    expect(ours[1].totals).toMatchObject({ overtime: 360, regular: 1080 })
  })
})

describe('an administrator filling in someone else’s timesheet', () => {
  it('saves and submits it with a reason, and records the hours before and after', async () => {
    const { id, status } = await sheetOf(partTimer, period2)
    expect(status).toBe('OPEN')

    const values = { 'worked-2031-03-19': '4h' }
    expect(
      (await refusal(saveTimesheet(approver1, { timesheetId: id, values, reason: 'Paper form' })))
        .message,
    ).toMatch(/your own/)
    expect(
      (await refusal(saveTimesheet(admin, { timesheetId: id, values }))).fieldErrors?.reason,
    ).toBeDefined()

    await saveTimesheet(admin, {
      timesheetId: id,
      values,
      submit: true,
      reason: 'Handed in on paper',
    })

    expect((await sheetOf(partTimer, period2)).status).toBe('SUBMITTED')
    const audit = await db.auditLog.findMany({
      where: { entityId: id, action: { in: ['timesheet.override.edit', 'timesheet.override.submit'] } },
      orderBy: { createdAt: 'asc' },
      select: { action: true, actorId: true, reason: true, after: true },
    })
    expect(audit.map((a) => [a.action, a.actorId, a.reason])).toEqual([
      ['timesheet.override.edit', admin.id, 'Handed in on paper'],
      ['timesheet.override.submit', admin.id, 'Handed in on paper'],
    ])
    expect(audit[0].after).toEqual({ worked: [{ date: '2031-03-19', minutes: 240 }] })
  })
})
