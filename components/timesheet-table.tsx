import Link from 'next/link'

import { currentStep } from '@/lib/requests/chain'
import {
  TIMESHEET_STATUS_LABEL,
  formatPeriod,
  timesheetTone,
  type TimesheetStatus,
} from '@/lib/timesheets/format'
import type { TimesheetListItem } from '@/lib/timesheets/queries'

/**
 * A list of timesheets, one card each. Two or three facts per row fit a
 * phone as they are, so there is no separate table layout.
 */
export function TimesheetTable({
  timesheets,
  showEmployee = false,
  empty,
}: {
  timesheets: TimesheetListItem[]
  showEmployee?: boolean
  empty: string
}) {
  if (timesheets.length === 0) return <p className="text-sm text-muted">{empty}</p>

  return (
    <ul className="th-card divide-y divide-border">
      {timesheets.map((t) => {
        const current = t.status === 'SUBMITTED' ? currentStep(t.steps) : null
        const waiting = current
          ? current.approver
            ? `Waiting on ${current.approver.firstName} ${current.approver.lastName}`
            : 'Waiting on an administrator'
          : null
        return (
          <li key={t.id}>
            <Link
              href={`/timesheets/${t.id}`}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 p-4 hover:bg-background"
            >
              <span className="min-w-0 text-sm">
                {showEmployee && (
                  <span className="block font-medium">
                    {t.employee.firstName} {t.employee.lastName}
                  </span>
                )}
                {formatPeriod(t.payPeriod)}
              </span>
              <span className="flex items-center gap-3">
                {waiting && <span className="text-xs text-muted">{waiting}</span>}
                <TimesheetStatusBadge status={t.status} />
              </span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

export function TimesheetStatusBadge({ status }: { status: TimesheetStatus }) {
  return (
    <span
      className={`inline-block shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${timesheetTone(status)}`}
    >
      {TIMESHEET_STATUS_LABEL[status]}
    </span>
  )
}
