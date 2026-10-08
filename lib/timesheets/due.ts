/**
 * When a timesheet is due, and whether it was in on time.
 *
 * Pure. The offset is an org setting (rule 1): a timesheet is due by the end
 * of that many days after its period's last day, in the org's timezone. Late
 * timesheets are accepted — exceptions are made — so lateness is something
 * shown, never something enforced.
 */

import { addDays, toUtcDay, todayIn } from '@/lib/accrual/dates'

export type Timeliness =
  /** Not submitted, and the due date has not passed. */
  | 'DUE'
  /** Not submitted, and the due date has passed. */
  | 'OVERDUE'
  | 'ON_TIME'
  | 'LATE'

export function timesheetDueDate(periodEnd: Date, dueDaysAfterPeriodEnd: number): Date {
  return addDays(periodEnd, dueDaysAfterPeriodEnd)
}

/**
 * Judged on the *first* submission. A timesheet sent back for a correction,
 * or unlocked by an administrator, and resubmitted after the due date was
 * still in on time — the correction is not the employee being late.
 */
export function timeliness(args: {
  dueDate: Date
  firstSubmittedAt: Date | null
  now: Date
  timeZone: string
}): Timeliness {
  const due = toUtcDay(args.dueDate)
  if (args.firstSubmittedAt) {
    return toUtcDay(todayIn(args.timeZone, args.firstSubmittedAt)) > due ? 'LATE' : 'ON_TIME'
  }
  return toUtcDay(todayIn(args.timeZone, args.now)) > due ? 'OVERDUE' : 'DUE'
}

export const TIMELINESS_LABEL: Record<Timeliness, string> = {
  DUE: 'Due',
  OVERDUE: 'Overdue',
  ON_TIME: 'On time',
  LATE: 'Late',
}
