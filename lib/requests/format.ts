/**
 * Rendering request dates and states. Display only — nothing computes on
 * what these return.
 */

/**
 * A leave date. DATE columns hold a UTC midnight with no zone (rule 7), so
 * they are rendered *in* UTC: rendering one in New York would print the day
 * before.
 */
export function formatLeaveDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/** "Mon, Oct 12, 2026" or "Mon, Oct 12, 2026 – Fri, Oct 16, 2026". */
export function formatDateSpan(dates: readonly Date[]): string {
  if (dates.length === 0) return '—'
  const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime())
  const first = formatLeaveDate(sorted[0])
  const last = formatLeaveDate(sorted[sorted.length - 1])
  return first === last ? first : `${first} – ${last}`
}

/** A moment something happened, in the org's timezone rather than the server's. */
export function formatTimestamp(date: Date, timeZone: string): string {
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  })
}

export const REQUEST_STATUS_LABEL = {
  DRAFT: 'Draft',
  PENDING: 'Pending',
  APPROVED: 'Approved',
  DENIED: 'Denied',
  CANCELLED: 'Cancelled',
} as const

export const STEP_STATUS_LABEL = {
  PENDING: 'Not yet',
  APPROVED: 'Approved',
  DENIED: 'Denied',
  SKIPPED: 'Skipped',
} as const

export function statusTone(status: keyof typeof REQUEST_STATUS_LABEL): string {
  switch (status) {
    case 'APPROVED':
      return 'border-green-600/40 text-green-700 dark:text-green-400'
    case 'DENIED':
      return 'border-danger/40 text-danger'
    case 'PENDING':
      return 'border-accent/40 text-accent'
    default:
      return 'border-border text-muted'
  }
}
