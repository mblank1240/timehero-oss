/** Rendering timesheet states and periods. Display only. */

import { formatLeaveDate } from '@/lib/requests/format'

export const TIMESHEET_STATUS_LABEL = {
  OPEN: 'Open',
  SUBMITTED: 'Submitted',
  APPROVED: 'Approved',
  REJECTED: 'Sent back',
} as const

export type TimesheetStatus = keyof typeof TIMESHEET_STATUS_LABEL

export function timesheetTone(status: TimesheetStatus): string {
  switch (status) {
    case 'APPROVED':
      return 'border-green-600/40 text-green-700 dark:text-green-400'
    case 'REJECTED':
      return 'border-danger/40 text-danger'
    case 'SUBMITTED':
      return 'border-accent/40 text-accent'
    default:
      return 'border-border text-muted'
  }
}

/** "Sun, Oct 4, 2026 – Sat, Oct 17, 2026". */
export function formatPeriod(period: { startDate: Date; endDate: Date }): string {
  return `${formatLeaveDate(period.startDate)} – ${formatLeaveDate(period.endDate)}`
}
