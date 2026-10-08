/**
 * The notifications the approval services send.
 *
 * Leave requests, overtime logs and timesheets move through the same chain
 * (`lib/requests/chain.ts`), so they announce the same three things: a step
 * is now waiting on someone, a step was rerouted to someone else, and the
 * whole thing was decided. Each service calls these inside its own
 * transaction; the reminder sweep calls `approvalReminderDrafts` on its own.
 */

import type { Prisma, PrismaClient } from '@prisma/client'

import { db } from '@/lib/db'
import { formatDuration } from '@/lib/duration'
import { formatDateSpan, formatLeaveDate } from '@/lib/requests/format'
import { formatPeriod } from '@/lib/timesheets/format'

import { createNotifications, type NotificationDraft } from './notify'

type Client = PrismaClient | Prisma.TransactionClient

export type SubjectKind = 'LEAVE' | 'OVERTIME' | 'TIMESHEET'
export type Subject = { kind: SubjectKind; id: string }

type Described = {
  requesterId: string
  requesterName: string
  /** For the approver: "2 days of PTO, Mon, Oct 12, 2026 – …". */
  what: string
  /** For the requester: "Your PTO request for …". */
  yours: string
  url: string
}

/** What a subject is, in words, read inside the caller's transaction. */
export async function describeSubject(subject: Subject, client: Client = db): Promise<Described> {
  const org = await client.orgSettings.findUniqueOrThrow({
    where: { id: 1 },
    select: { displayUnit: true },
  })
  const person = { firstName: true, lastName: true, standardMinutesPerDay: true } as const

  switch (subject.kind) {
    case 'LEAVE': {
      const r = await client.leaveRequest.findUniqueOrThrow({
        where: { id: subject.id },
        select: {
          employeeId: true,
          totalMinutes: true,
          employee: { select: person },
          leaveType: { select: { name: true } },
        },
      })
      const days = await client.leaveRequestDay.findMany({
        where: { leaveRequestId: subject.id },
        select: { date: true },
      })
      const amount = formatDuration(r.totalMinutes, {
        unit: org.displayUnit,
        minutesPerDay: r.employee.standardMinutesPerDay,
      })
      const span = formatDateSpan(days.map((d) => d.date))
      return {
        requesterId: r.employeeId,
        requesterName: `${r.employee.firstName} ${r.employee.lastName}`,
        what: `${amount} of ${r.leaveType.name}, ${span}`,
        yours: `Your ${r.leaveType.name} request for ${span}`,
        url: `/requests/${subject.id}`,
      }
    }
    case 'OVERTIME': {
      const l = await client.overtimeLog.findUniqueOrThrow({
        where: { id: subject.id },
        select: { employeeId: true, date: true, minutes: true, employee: { select: person } },
      })
      const amount = formatDuration(l.minutes, { unit: 'HOURS', minutesPerDay: 1 })
      const day = formatLeaveDate(l.date)
      return {
        requesterId: l.employeeId,
        requesterName: `${l.employee.firstName} ${l.employee.lastName}`,
        what: `${amount} of overtime on ${day}`,
        yours: `Your overtime on ${day}`,
        url: `/overtime/${subject.id}`,
      }
    }
    case 'TIMESHEET': {
      const t = await client.timesheet.findUniqueOrThrow({
        where: { id: subject.id },
        select: {
          employeeId: true,
          employee: { select: person },
          payPeriod: { select: { startDate: true, endDate: true } },
        },
      })
      const period = formatPeriod(t.payPeriod)
      return {
        requesterId: t.employeeId,
        requesterName: `${t.employee.firstName} ${t.employee.lastName}`,
        what: `timesheet for ${period}`,
        yours: `Your timesheet for ${period}`,
        url: `/timesheets/${subject.id}`,
      }
    }
  }
}

/**
 * Who a step waits on: its approver, or — the empty-chain case — every
 * active administrator except the requester, any of whom may act.
 */
export async function stepRecipients(
  step: { approverId: string | null },
  requesterId: string,
  client: Client = db,
): Promise<string[]> {
  if (step.approverId) return [step.approverId]
  const admins = await client.employee.findMany({
    where: { role: 'ADMIN', isActive: true, id: { not: requesterId } },
    select: { id: true },
  })
  return admins.map((a) => a.id)
}

const KIND_NOUN: Record<SubjectKind, string> = {
  LEAVE: 'Leave request',
  OVERTIME: 'Overtime',
  TIMESHEET: 'Timesheet',
}

/**
 * A step has started waiting on someone: on submission, when the step before
 * it is approved, or when an administrator reroutes it. Keyed by step and
 * approver, so a reroute reaches the new approver and a repeat reaches nobody.
 */
export async function notifyStepWaiting(
  subject: Subject,
  step: { id: string; approverId: string | null },
  client: Client,
  how: 'arrived' | 'rerouted' = 'arrived',
): Promise<number> {
  const d = await describeSubject(subject, client)
  const recipients = await stepRecipients(step, d.requesterId, client)
  const drafts: NotificationDraft[] = recipients.map((recipientId) => ({
    recipientId,
    type: 'APPROVAL_WAITING',
    key: `waiting:${step.id}:${recipientId}`,
    title: `${KIND_NOUN[subject.kind]} waiting on you`,
    body:
      how === 'rerouted'
        ? `${d.requesterName}’s ${d.what} has been passed to you to decide.`
        : `${d.requesterName}: ${d.what}.`,
    url: d.url,
  }))
  return createNotifications(drafts, client)
}

export type Resolution = 'APPROVED' | 'DENIED' | 'REJECTED'

const RESOLUTION_WORD: Record<Resolution, string> = {
  APPROVED: 'was approved',
  DENIED: 'was denied',
  REJECTED: 'was sent back for changes',
}

/**
 * The whole chain has finished, one way or the other. Tells the requester.
 * Keyed by the step that decided it: a timesheet sent back twice is two
 * decisions, by two different steps.
 */
export async function notifyResolved(
  subject: Subject,
  resolution: Resolution,
  decidedStepId: string,
  client: Client,
  comment?: string | null,
): Promise<number> {
  const d = await describeSubject(subject, client)
  const title = `${KIND_NOUN[subject.kind]} ${RESOLUTION_WORD[resolution].replace('was ', '')}`
  return createNotifications(
    [
      {
        recipientId: d.requesterId,
        type: 'REQUEST_DECIDED',
        key: `resolved:${decidedStepId}`,
        title: title.charAt(0).toUpperCase() + title.slice(1),
        body: `${d.yours} ${RESOLUTION_WORD[resolution]}.${comment ? ` “${comment}”` : ''}`,
        url: d.url,
      },
    ],
    client,
  )
}

/** A reminder for one waiting step, in the slot `schedule.ts` named. */
export async function approvalReminderDrafts(
  subject: Subject,
  step: { id: string; approverId: string | null },
  slot: { key: string; escalated: boolean },
  waitingDays: number,
  client: Client = db,
): Promise<NotificationDraft[]> {
  const d = await describeSubject(subject, client)
  const recipients = await stepRecipients(step, d.requesterId, client)
  const waited = waitingDays === 1 ? '1 day' : `${waitingDays} days`
  return recipients.map((recipientId) => ({
    recipientId,
    type: 'APPROVAL_WAITING',
    key: `reminder:${step.id}:${recipientId}:${slot.key}`,
    title: slot.escalated
      ? `Overdue: ${KIND_NOUN[subject.kind].toLowerCase()} still waiting on you`
      : `Reminder: ${KIND_NOUN[subject.kind].toLowerCase()} waiting on you`,
    body: `${d.requesterName}’s ${d.what} has been waiting ${waited} for your decision.`,
    url: d.url,
  }))
}
