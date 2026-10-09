/**
 * The hourly notification sweep.
 *
 * Arrivals and decisions are announced by the services as they happen. This
 * job sends what is owed with the passing of time — approval reminders as
 * they escalate, timesheet due and overdue reminders, and approvers' daily
 * digests — and then delivers anything still waiting to go out by push or
 * email, including retries.
 *
 * Every reminder carries a key naming the slot or the occasion, unique per
 * recipient, so a sweep that runs twice, late, or for a past date sends
 * nothing twice (rule 3).
 */

import { addDays, todayIn } from '@/lib/accrual/dates'
import { db } from '@/lib/db'
import { appUrl } from '@/lib/env'
import { orgSettingsOrThrow } from '@/lib/ledger/policies'
import { sendMail, sendingAddress } from '@/lib/mail'
import { deliverNotifications } from '@/lib/notifications/deliver'
import {
  approvalReminderDrafts,
  describeSubject,
  type Subject,
} from '@/lib/notifications/events'
import { createNotifications, type NotificationDraft } from '@/lib/notifications/notify'
import { hourIn, reminderSlot, timesheetReminder, waitingSince } from '@/lib/notifications/schedule'
import { formatLeaveDate } from '@/lib/requests/format'
import { timesheetDueDate } from '@/lib/timesheets/due'
import { formatPeriod } from '@/lib/timesheets/format'

import type { JobOutcome } from './runner'
import { effectivePermissions } from '@/lib/permissions'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How far back a missed sweep still sends an overdue reminder. Operational,
 * not policy: it stops the first run after an outage — or after this feature
 * is switched on — reminding everyone about every timesheet they ever left
 * blank.
 */
const OVERDUE_CATCH_UP_DAYS = 7

export async function runSendNotifications(asOf: Date): Promise<JobOutcome> {
  // The job acts at a moment, not just on a date: reminders escalate by the
  // hour. Today is now; a past date is acted on as at its last moment.
  const now = new Date(Math.min(Date.now(), asOf.getTime() + DAY_MS - 1))
  const org = await orgSettingsOrThrow()

  const waiting = await waitingSteps()

  const reminders = await sendApprovalReminders(waiting, now, org)
  const timesheets = await sendTimesheetReminders(now, org)
  const digests = await sendDigests(waiting, now, org)
  const delivered = await deliverNotifications(now)

  return {
    entriesCreated: reminders + timesheets + digests.sent,
    detail: {
      at: now.toISOString(),
      waitingSteps: waiting.length,
      approvalReminders: reminders,
      timesheetReminders: timesheets,
      digestsSent: digests.sent,
      digestsFailed: digests.failed,
      ...delivered,
    },
  }
}

type Org = Awaited<ReturnType<typeof orgSettingsOrThrow>>

type WaitingStep = {
  id: string
  approverId: string | null
  since: Date
  subject: Subject
}

/** The step each pending leave request, overtime log and timesheet is waiting on. */
async function waitingSteps(): Promise<WaitingStep[]> {
  const pending = await db.approvalStep.findMany({
    where: {
      status: 'PENDING',
      OR: [
        { leaveRequest: { status: 'PENDING' } },
        { overtimeLog: { status: 'PENDING' } },
        { timesheet: { status: 'SUBMITTED' } },
      ],
    },
    orderBy: { step: 'asc' },
    select: {
      id: true,
      step: true,
      approverId: true,
      createdAt: true,
      leaveRequestId: true,
      overtimeLogId: true,
      timesheetId: true,
    },
  })

  // Lowest pending step per subject.
  const current = new Map<string, (typeof pending)[number]>()
  for (const s of pending) {
    const key = s.leaveRequestId ?? s.overtimeLogId ?? s.timesheetId!
    if (!current.has(key)) current.set(key, s)
  }

  const result: WaitingStep[] = []
  for (const s of current.values()) {
    const where = s.leaveRequestId
      ? { leaveRequestId: s.leaveRequestId }
      : s.overtimeLogId
        ? { overtimeLogId: s.overtimeLogId }
        : { timesheetId: s.timesheetId }
    const earlier = await db.approvalStep.findMany({
      where: { ...where, step: { lt: s.step } },
      select: { step: true, decidedAt: true },
    })
    const subject: Subject = s.leaveRequestId
      ? { kind: 'LEAVE', id: s.leaveRequestId }
      : s.overtimeLogId
        ? { kind: 'OVERTIME', id: s.overtimeLogId }
        : { kind: 'TIMESHEET', id: s.timesheetId! }
    result.push({ id: s.id, approverId: s.approverId, since: waitingSince(s, earlier), subject })
  }
  return result
}

async function sendApprovalReminders(waiting: WaitingStep[], now: Date, org: Org) {
  const drafts: NotificationDraft[] = []
  for (const step of waiting) {
    const slot = reminderSlot(step.since, now, org)
    if (!slot) continue
    const days = Math.floor((now.getTime() - step.since.getTime()) / DAY_MS)
    drafts.push(...(await approvalReminderDrafts(step.subject, step, slot, days)))
  }
  return createNotifications(drafts)
}

async function sendTimesheetReminders(now: Date, org: Org) {
  const today = todayIn(org.timezone, now)

  const sheets = await db.timesheet.findMany({
    where: {
      status: 'OPEN',
      submittedAt: null,
      employee: { isActive: true },
      payPeriod: {
        startDate: { lte: today },
        endDate: {
          gte: addDays(today, -(org.timesheetDueDaysAfterPeriodEnd + OVERDUE_CATCH_UP_DAYS)),
        },
      },
    },
    select: {
      id: true,
      employeeId: true,
      payPeriod: { select: { startDate: true, endDate: true } },
    },
  })

  const drafts: NotificationDraft[] = []
  for (const sheet of sheets) {
    const dueDate = timesheetDueDate(sheet.payPeriod.endDate, org.timesheetDueDaysAfterPeriodEnd)
    const which = timesheetReminder({
      today,
      periodEnd: sheet.payPeriod.endDate,
      dueDate,
      leadDays: org.timesheetReminderDaysBeforePeriodEnd,
    })
    if (!which) continue

    const period = formatPeriod(sheet.payPeriod)
    const due = formatLeaveDate(dueDate)
    drafts.push(
      which === 'DUE'
        ? {
            recipientId: sheet.employeeId,
            type: 'TIMESHEET_DUE',
            key: `timesheet-due:${sheet.id}`,
            title: `Timesheet due ${due}`,
            body: `Your timesheet for ${period} is due by the end of ${due}.`,
            url: `/timesheets/${sheet.id}`,
          }
        : {
            recipientId: sheet.employeeId,
            type: 'TIMESHEET_OVERDUE',
            key: `timesheet-overdue:${sheet.id}`,
            title: 'Timesheet overdue',
            body: `Your timesheet for ${period} was due ${due}. Please submit it as soon as you can.`,
            url: `/timesheets/${sheet.id}`,
          },
    )
  }
  return createNotifications(drafts)
}

/**
 * One email a day to each approver who chose a digest, listing everything
 * waiting on them, sent the first time the sweep runs at or after the org's
 * digest hour. Push and the in-app list still arrive one at a time.
 */
async function sendDigests(waiting: WaitingStep[], now: Date, org: Org) {
  const counts = { sent: 0, failed: 0 }

  if (!org.notificationTypesEnabled.includes('APPROVAL_WAITING')) return counts
  if (hourIn(org.timezone, now) < org.approverDigestHour) return counts
  if (!(await sendingAddress())) return counts

  const approvers = await db.employee.findMany({
    where: {
      approvalDigest: true,
      isActive: true,
      // Turning email off for approvals turns the digest off too.
      notificationPrefs: { none: { type: 'APPROVAL_WAITING', email: false } },
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      accessRole: { select: { permissions: true, allPermissions: true } },
    },
  })
  if (approvers.length === 0) return counts

  const today = todayIn(org.timezone, now)
  const described = new Map<string, Awaited<ReturnType<typeof describeSubject>>>()

  for (const approver of approvers) {
    const mine = []
    for (const step of waiting) {
      if (!described.has(step.subject.id)) {
        described.set(step.subject.id, await describeSubject(step.subject))
      }
      const d = described.get(step.subject.id)!
      const theirs =
        step.approverId === approver.id ||
        (step.approverId === null &&
          effectivePermissions(approver.accessRole).includes('MANAGE_TIME_RECORDS') &&
          d.requesterId !== approver.id)
      if (theirs) mine.push({ step, d })
    }
    if (mine.length === 0) continue

    // Claimed before sending: the unique (employee, date) is what stops a
    // second sweep the same day sending it again.
    try {
      await db.notificationDigest.create({
        data: { employeeId: approver.id, date: today, itemCount: mine.length },
      })
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') continue
      throw error
    }

    const lines = mine.map(({ step, d }) => {
      const days = Math.floor((now.getTime() - step.since.getTime()) / DAY_MS)
      const waited = days === 0 ? 'today' : days === 1 ? '1 day' : `${days} days`
      return `• ${d.requesterName}: ${d.what} — waiting ${waited}\n  ${appUrl()}${d.url}`
    })

    try {
      await sendMail({
        to: approver.email,
        subject:
          mine.length === 1
            ? '1 thing is waiting on you in TimeHero'
            : `${mine.length} things are waiting on you in TimeHero`,
        text: [
          `Hi ${approver.firstName},`,
          '',
          'Waiting for your decision:',
          '',
          ...lines,
          '',
          `All of them: ${appUrl()}/approvals`,
          '',
          '—',
          `You get this once a day instead of an email for each one. Change it at ${appUrl()}/notifications`,
        ].join('\n'),
      })
      counts.sent += 1
    } catch (error) {
      // Released so the next hour's sweep tries again.
      await db.notificationDigest.deleteMany({
        where: { employeeId: approver.id, date: today },
      })
      console.error('Could not send an approval digest', error)
      counts.failed += 1
    }
  }

  return counts
}
