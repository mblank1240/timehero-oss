/**
 * When reminders fall due. Pure.
 *
 * Approvals escalate the way the church's old Power Automate flow did: one
 * notification on arrival (sent by the service, not here), then — once the
 * item has waited `reminderAfterDays` — one every `reminderIntervalHours`,
 * and once it has waited a further `escalateAfterDays`, one every
 * `escalateIntervalHours`. All four are org settings (rule 1).
 *
 * The sweep runs hourly and may run late, twice, or skip an hour. So rather
 * than "is a reminder due now", this names the *slot* the moment falls in;
 * the slot is part of the notification's unique key, which is what makes a
 * slot send exactly once however often the sweep runs (rule 3). A sweep that
 * misses several slots sends only the current one — nobody needs four
 * reminders at once.
 */

import { toUtcDay } from '@/lib/accrual/dates'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export type EscalationSettings = {
  approvalReminderAfterDays: number
  approvalReminderIntervalHours: number
  approvalEscalateAfterDays: number
  approvalEscalateIntervalHours: number
}

export type ReminderSlot = { key: string; escalated: boolean }

/** The reminder slot `now` falls in, or null before reminders start. */
export function reminderSlot(
  waitingSince: Date,
  now: Date,
  s: EscalationSettings,
): ReminderSlot | null {
  const elapsed = now.getTime() - waitingSince.getTime()
  const start = s.approvalReminderAfterDays * DAY_MS
  const escalate = start + s.approvalEscalateAfterDays * DAY_MS

  if (elapsed < start) return null

  if (elapsed < escalate) {
    const n = Math.floor((elapsed - start) / (s.approvalReminderIntervalHours * HOUR_MS))
    return { key: `daily-${n}`, escalated: false }
  }

  const n = Math.floor((elapsed - escalate) / (s.approvalEscalateIntervalHours * HOUR_MS))
  return { key: `frequent-${n}`, escalated: true }
}

/**
 * When the current step started waiting: the snapshot was taken (every step
 * is created at submission), or the step before it was decided — whichever
 * is later. A timesheet submitted again numbers its new steps after the old
 * ones, whose decisions all predate the new snapshot, so the same rule holds.
 */
export function waitingSince(
  step: { step: number; createdAt: Date },
  siblings: readonly { step: number; decidedAt: Date | null }[],
): Date {
  let since = step.createdAt
  for (const s of siblings) {
    if (s.step < step.step && s.decidedAt && s.decidedAt > since) since = s.decidedAt
  }
  return since
}

export type TimesheetReminder = 'DUE' | 'OVERDUE' | null

/**
 * Which reminder a timesheet that has never been submitted is owed today.
 *
 * "Due" from `leadDays` before the period's last day until its due date;
 * "overdue" once the due date has passed. Each is sent once per timesheet,
 * by its key, so this only says which window today is in.
 */
export function timesheetReminder(args: {
  today: Date
  periodEnd: Date
  dueDate: Date
  leadDays: number
}): TimesheetReminder {
  const today = toUtcDay(args.today)
  if (today > toUtcDay(args.dueDate)) return 'OVERDUE'
  if (today >= toUtcDay(args.periodEnd) - args.leadDays) return 'DUE'
  return null
}

/** The hour of the day `now` is in `timeZone`, 0–23. */
export function hourIn(timeZone: string, now: Date): number {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).format(now)
  return Number(hour)
}
