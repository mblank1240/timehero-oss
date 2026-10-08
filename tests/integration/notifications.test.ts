import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { addDays, todayIn } from '@/lib/accrual/dates'
import { db } from '@/lib/db'
import { env } from '@/lib/env'
import { runSendNotifications } from '@/lib/jobs/notifications'
import { deliverNotifications } from '@/lib/notifications/deliver'
import { notifyStepWaiting } from '@/lib/notifications/events'
import { sendPush } from '@/lib/notifications/push'
import type { Actor } from '@/lib/requests/chain'
import {
  decideLeaveRequest,
  rerouteLeaveRequest,
  submitLeaveRequest,
} from '@/lib/requests/service'

/**
 * Notifications against real Postgres: what the approval services announce
 * and to whom, the channels each row is owed, delivery, and the hourly sweep's
 * reminders and digest — each sent once, however often the sweep runs.
 *
 * Push never leaves the machine: the sender is mocked. Email goes through the
 * file transport (the default outside production) from the seeded address.
 */

vi.mock('@/lib/notifications/push', () => ({ sendPush: vi.fn() }))
const pushed = vi.mocked(sendPush)

const RUN = `ntest-${Date.now().toString(36)}`
const DAY = 480

let leaveTypeId: string
let today: Date
let holidays: Set<string>
const employeeIds: string[] = []
let original: {
  mailFromAddress: string | null
  notificationTypesEnabled: string[]
  approverDigestHour: number
  timesheetReminderDaysBeforePeriodEnd: number
}

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

let offset = 0
async function submit(requester: Actor) {
  offset += 1
  const day = futureDay(offset)
  return submitLeaveRequest(requester, {
    leaveTypeId,
    days: [{ date: day, minutes: String(DAY) }],
  })
}

async function inbox(employeeId: string) {
  return db.notification.findMany({
    where: { recipientId: employeeId },
    orderBy: { createdAt: 'asc' },
    select: {
      type: true,
      key: true,
      title: true,
      body: true,
      url: true,
      pushStatus: true,
      emailStatus: true,
    },
  })
}

/** Every message the file transport wrote to `to`. */
async function mailTo(to: string): Promise<{ from: string; subject: string; text: string }[]> {
  const dir = path.resolve(env.MAIL_FILE_DIR)
  const files = await readdir(dir).catch(() => [] as string[])
  const found = []
  for (const file of files) {
    const mail = JSON.parse(await readFile(path.join(dir, file), 'utf8'))
    if (mail.to === to) found.push(mail)
  }
  return found
}

async function emailOf(actor: Actor) {
  return (await db.employee.findUniqueOrThrow({ where: { id: actor.id } })).email
}

beforeAll(async () => {
  const org = await db.orgSettings.findUnique({ where: { id: 1 } })
  if (!org) throw new Error('Run `npm run db:seed` before the integration tests.')
  original = {
    mailFromAddress: org.mailFromAddress,
    notificationTypesEnabled: org.notificationTypesEnabled,
    approverDigestHour: org.approverDigestHour,
    timesheetReminderDaysBeforePeriodEnd: org.timesheetReminderDaysBeforePeriodEnd,
  }
  today = todayIn(org.timezone)
  holidays = new Set((await db.holiday.findMany()).map((h) => iso(h.date)))

  const type = await db.leaveType.create({
    data: { code: `${RUN}-LV`, name: `${RUN} Leave`, allowsNegativeBalance: true },
  })
  leaveTypeId = type.id
})

beforeEach(async () => {
  pushed.mockReset()
  await db.orgSettings.update({
    where: { id: 1 },
    data: {
      mailFromAddress: 'time@example.test',
      notificationTypesEnabled: {
        set: [
          'APPROVAL_WAITING',
          'REQUEST_DECIDED',
          'TIMESHEET_DUE',
          'TIMESHEET_OVERDUE',
          'ROLLOVER_SUMMARY',
        ],
      },
    },
  })
})

afterAll(async () => {
  await db.orgSettings.update({
    where: { id: 1 },
    data: {
      mailFromAddress: original.mailFromAddress,
      notificationTypesEnabled: {
        set: original.notificationTypesEnabled as ('APPROVAL_WAITING' | 'REQUEST_DECIDED')[],
      },
      approverDigestHour: original.approverDigestHour,
      timesheetReminderDaysBeforePeriodEnd: original.timesheetReminderDaysBeforePeriodEnd,
    },
  })

  const requests = await db.leaveRequest.findMany({
    where: { employeeId: { in: employeeIds } },
    select: { id: true },
  })
  const sheets = await db.timesheet.findMany({
    where: { employeeId: { in: employeeIds } },
    select: { id: true },
  })
  await db.auditLog.deleteMany({
    where: { entityId: { in: [...requests, ...sheets].map((r) => r.id) } },
  })
  // Notifications about these requests that reached real administrators.
  await db.notification.deleteMany({
    where: { url: { in: requests.map((r) => `/requests/${r.id}`) } },
  })
  await db.leaveRequest.deleteMany({ where: { employeeId: { in: employeeIds } } })
  await db.timesheet.deleteMany({ where: { employeeId: { in: employeeIds } } })
  await db.ledgerEntry.deleteMany({ where: { leaveTypeId } })
  await db.approvalChainStep.deleteMany({ where: { employeeId: { in: employeeIds } } })
  await db.employee.deleteMany({ where: { id: { in: employeeIds } } })
  await db.leaveType.deleteMany({ where: { id: leaveTypeId } })
})

describe('what the approval chain announces', () => {
  it('tells each approver in turn, the new approver on a reroute, and the requester at the end', async () => {
    const [a, b, c] = [await person('a1'), await person('b1'), await person('c1')]
    const boss = await person('boss1', { role: 'ADMIN' })
    const requester = await person('req1')
    await chain(requester.id, [a, b])

    const { id } = await submit(requester)

    expect(await inbox(a.id)).toEqual([
      expect.objectContaining({
        type: 'APPROVAL_WAITING',
        title: 'Leave request waiting on you',
        url: `/requests/${id}`,
        // No browser subscribed; the org has an address.
        pushStatus: null,
        emailStatus: 'PENDING',
      }),
    ])
    expect((await inbox(a.id))[0].body).toContain(`${RUN} req1: 1 day of ${RUN} Leave`)
    // Step 2 hears nothing until step 1 has decided.
    expect(await inbox(b.id)).toEqual([])

    await decideLeaveRequest(a, { requestId: id, decision: 'APPROVE' })
    expect(await inbox(b.id)).toHaveLength(1)

    await rerouteLeaveRequest(boss, { requestId: id, approverId: c.id, reason: 'B is away' })
    const rerouted = await inbox(c.id)
    expect(rerouted).toHaveLength(1)
    expect(rerouted[0].body).toMatch(/has been passed to you to decide/)

    expect(await inbox(requester.id)).toEqual([])
    await decideLeaveRequest(c, { requestId: id, decision: 'APPROVE' })
    expect(await inbox(requester.id)).toEqual([
      expect.objectContaining({
        type: 'REQUEST_DECIDED',
        title: 'Leave request approved',
        url: `/requests/${id}`,
      }),
    ])
  })

  it('a denial tells the requester why, and the steps after it hear nothing', async () => {
    const [a, b] = [await person('a2'), await person('b2')]
    const requester = await person('req2')
    await chain(requester.id, [a, b])

    const { id } = await submit(requester)
    await decideLeaveRequest(a, { requestId: id, decision: 'DENY', comment: 'Short-staffed' })

    const [decided] = await inbox(requester.id)
    expect(decided.title).toBe('Leave request denied')
    expect(decided.body).toMatch(/was denied\. “Short-staffed”$/)
    expect(await inbox(b.id)).toEqual([])
  })

  it('an empty chain reaches every administrator but the requester', async () => {
    const admin = await person('admin3', { role: 'ADMIN' })
    const requester = await person('req3', { role: 'ADMIN' })
    const { id } = await submit(requester)

    expect(await inbox(admin.id)).toHaveLength(1)
    expect(await inbox(requester.id)).toEqual([])
    expect(
      await db.notification.count({ where: { url: `/requests/${id}`, type: 'APPROVAL_WAITING' } }),
    ).toBeGreaterThanOrEqual(1)
  })

  it('announces a step once, however many times it is asked to', async () => {
    const a = await person('a4')
    const requester = await person('req4')
    await chain(requester.id, [a])

    const { id } = await submit(requester)
    const step = await db.approvalStep.findFirstOrThrow({ where: { leaveRequestId: id } })
    expect(await notifyStepWaiting({ kind: 'LEAVE', id }, step, db)).toBe(0)
    expect(await inbox(a.id)).toHaveLength(1)
  })
})

describe('channels', () => {
  it('sends nothing for a type the organization switched off', async () => {
    await db.orgSettings.update({
      where: { id: 1 },
      data: { notificationTypesEnabled: { set: ['REQUEST_DECIDED'] } },
    })
    const a = await person('a5')
    const requester = await person('req5')
    await chain(requester.id, [a])

    await submit(requester)
    expect(await inbox(a.id)).toEqual([])
  })

  it('sends no email without a sending address', async () => {
    await db.orgSettings.update({ where: { id: 1 }, data: { mailFromAddress: null } })
    const a = await person('a6')
    const requester = await person('req6')
    await chain(requester.id, [a])

    await submit(requester)
    expect(await inbox(a.id)).toEqual([expect.objectContaining({ emailStatus: null })])
  })

  it('follows each person’s choices, and holds approval email for a digest', async () => {
    const a = await person('a7')
    const requester = await person('req7')
    await chain(requester.id, [a])
    await db.employee.update({ where: { id: a.id }, data: { approvalDigest: true } })
    await db.notificationPreference.create({
      data: { employeeId: requester.id, type: 'REQUEST_DECIDED', push: true, email: false },
    })

    const { id } = await submit(requester)
    expect(await inbox(a.id)).toEqual([expect.objectContaining({ emailStatus: 'DIGEST' })])

    await decideLeaveRequest(a, { requestId: id, decision: 'APPROVE' })
    expect(await inbox(requester.id)).toEqual([expect.objectContaining({ emailStatus: null })])
  })
})

describe('delivery', () => {
  it('pushes to every subscribed browser, forgets one that has gone, and emails once', async () => {
    const a = await person('a8')
    const requester = await person('req8')
    await chain(requester.id, [a])
    await db.pushSubscription.createMany({
      data: [
        { employeeId: a.id, endpoint: `https://push.example.test/${RUN}/live`, p256dh: 'k', auth: 'a' },
        { employeeId: a.id, endpoint: `https://push.example.test/${RUN}/gone`, p256dh: 'k', auth: 'a' },
      ],
    })
    pushed.mockImplementation(async (target) =>
      target.endpoint.endsWith('/gone') ? { result: 'GONE' } : { result: 'SENT' },
    )

    const { id } = await submit(requester)
    expect(await inbox(a.id)).toEqual([
      expect.objectContaining({ pushStatus: 'PENDING', emailStatus: 'PENDING' }),
    ])

    await deliverNotifications()

    expect(await inbox(a.id)).toEqual([
      expect.objectContaining({ pushStatus: 'SENT', emailStatus: 'SENT' }),
    ])
    expect(pushed).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: `https://push.example.test/${RUN}/live` }),
      expect.objectContaining({ title: 'Leave request waiting on you', url: `/requests/${id}` }),
    )
    expect(await db.pushSubscription.count({ where: { employeeId: a.id } })).toBe(1)

    const mail = await mailTo(await emailOf(a))
    expect(mail).toHaveLength(1)
    expect(mail[0].from).toBe('time@example.test')
    expect(mail[0].subject).toBe('Leave request waiting on you')
    expect(mail[0].text).toContain(`/requests/${id}`)

    // Delivered rows are not delivered again.
    pushed.mockClear()
    await deliverNotifications()
    expect(pushed).not.toHaveBeenCalled()
    expect(await mailTo(await emailOf(a))).toHaveLength(1)
  })

  it('retries a failed push, and gives up after five tries', async () => {
    const a = await person('a9')
    const requester = await person('req9')
    await chain(requester.id, [a])
    await db.pushSubscription.create({
      data: { employeeId: a.id, endpoint: `https://push.example.test/${RUN}/flaky`, p256dh: 'k', auth: 'a' },
    })
    pushed.mockResolvedValue({ result: 'FAILED', error: 'push service unavailable' })

    await submit(requester)
    await deliverNotifications()
    let [n] = await db.notification.findMany({ where: { recipientId: a.id } })
    expect(n).toMatchObject({ pushStatus: 'PENDING', attempts: 1, lastError: 'push service unavailable' })

    for (let i = 0; i < 4; i += 1) await deliverNotifications()
    ;[n] = await db.notification.findMany({ where: { recipientId: a.id } })
    expect(n).toMatchObject({ pushStatus: 'FAILED', attempts: 5 })
  })
})

describe('the hourly sweep', () => {
  it('reminds once per slot, then escalates', async () => {
    const a = await person('a10')
    const requester = await person('req10')
    await chain(requester.id, [a])
    const { id } = await submit(requester)
    const step = await db.approvalStep.findFirstOrThrow({ where: { leaveRequestId: id } })
    const org = await db.orgSettings.findUniqueOrThrow({ where: { id: 1 } })
    const hours = (h: number) => new Date(Date.now() - h * 3_600_000)

    // Not yet: just under the wait.
    await db.approvalStep.update({
      where: { id: step.id },
      data: { createdAt: hours(org.approvalReminderAfterDays * 24 - 1) },
    })
    await runSendNotifications(today)
    expect(await inbox(a.id)).toHaveLength(1)

    await db.approvalStep.update({
      where: { id: step.id },
      data: { createdAt: hours(org.approvalReminderAfterDays * 24 + 1) },
    })
    await runSendNotifications(today)
    await runSendNotifications(today)
    const reminded = await inbox(a.id)
    expect(reminded).toHaveLength(2)
    expect(reminded[1]).toMatchObject({
      key: `reminder:${step.id}:${a.id}:daily-0`,
      title: 'Reminder: leave request waiting on you',
    })
    expect(reminded[1].body).toContain(`waiting ${org.approvalReminderAfterDays} days`)

    await db.approvalStep.update({
      where: { id: step.id },
      data: {
        createdAt: hours((org.approvalReminderAfterDays + org.approvalEscalateAfterDays) * 24 + 1),
      },
    })
    await runSendNotifications(today)
    const escalated = await inbox(a.id)
    expect(escalated).toHaveLength(3)
    expect(escalated[2]).toMatchObject({
      key: `reminder:${step.id}:${a.id}:frequent-0`,
      title: 'Overdue: leave request still waiting on you',
    })

    // Decided: no more reminders, however long ago it arrived.
    await decideLeaveRequest(a, { requestId: id, decision: 'APPROVE' })
    await db.approvalStep.update({ where: { id: step.id }, data: { createdAt: hours(24 * 60) } })
    await runSendNotifications(today)
    expect(await inbox(a.id)).toHaveLength(3)
  })

  it('sends a digest approver one email a day listing what waits on them', async () => {
    await db.orgSettings.update({ where: { id: 1 }, data: { approverDigestHour: 0 } })
    const a = await person('a11')
    await db.employee.update({ where: { id: a.id }, data: { approvalDigest: true } })
    const [r1, r2] = [await person('req11a'), await person('req11b')]
    await chain(r1.id, [a])
    await chain(r2.id, [a])
    await submit(r1)
    await submit(r2)

    await runSendNotifications(today)
    await runSendNotifications(today)

    const mail = await mailTo(await emailOf(a))
    expect(mail).toHaveLength(1)
    expect(mail[0].subject).toBe('2 things are waiting on you in TimeHero')
    expect(mail[0].text).toContain(`${RUN} req11a: 1 day of ${RUN} Leave`)
    expect(
      await db.notificationDigest.findMany({ where: { employeeId: a.id }, select: { itemCount: true } }),
    ).toEqual([{ itemCount: 2 }])
    // The arrivals themselves were not emailed one by one.
    expect((await inbox(a.id)).map((n) => n.emailStatus)).toEqual(['DIGEST', 'DIGEST'])
  })

  it('reminds an hourly employee once that their timesheet is due', async () => {
    const schedule = await db.paySchedule.findFirstOrThrow({ where: { isDefault: true } })
    const period = await db.payPeriod.findFirstOrThrow({
      where: { payScheduleId: schedule.id, startDate: { lte: today }, endDate: { gte: today } },
    })
    // Wide enough that today is inside the window whatever day of the period it is.
    await db.orgSettings.update({
      where: { id: 1 },
      data: { timesheetReminderDaysBeforePeriodEnd: 31 },
    })
    const sam = await person('sam12', { type: 'HOURLY' })
    const sheet = await db.timesheet.create({ data: { employeeId: sam.id, payPeriodId: period.id } })

    await runSendNotifications(today)
    await runSendNotifications(today)

    expect(await inbox(sam.id)).toEqual([
      expect.objectContaining({
        type: 'TIMESHEET_DUE',
        key: `timesheet-due:${sheet.id}`,
        url: `/timesheets/${sheet.id}`,
      }),
    ])
  })
})
