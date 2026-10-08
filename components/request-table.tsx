import Link from 'next/link'

import { formatDuration, type DisplayUnit } from '@/lib/duration'
import { currentStep } from '@/lib/requests/chain'
import {
  REQUEST_STATUS_LABEL,
  STEP_STATUS_LABEL,
  formatDateSpan,
  statusTone,
} from '@/lib/requests/format'
import { waitingOn, type RequestListItem } from '@/lib/requests/queries'

/**
 * One list of requests, so they read the same everywhere. A table from the
 * small breakpoint up; below it, a stacked card per request, since six
 * columns do not fit a phone.
 */
export function RequestTable({
  requests,
  unit,
  showEmployee = false,
  empty,
}: {
  requests: RequestListItem[]
  unit: DisplayUnit
  showEmployee?: boolean
  empty: string
}) {
  if (requests.length === 0) return <p className="text-sm text-muted">{empty}</p>

  const amount = (r: RequestListItem) =>
    formatDuration(r.totalMinutes, { unit, minutesPerDay: r.employee.standardMinutesPerDay })

  return (
    <>
      <ul className="th-card divide-y divide-border sm:hidden">
        {requests.map((r) => (
          <li key={r.id}>
            <Link href={`/requests/${r.id}`} className="block space-y-2 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  {showEmployee && (
                    <p className="text-sm font-medium">
                      {r.employee.firstName} {r.employee.lastName}
                    </p>
                  )}
                  <p className="text-sm">{formatDateSpan(r.days.map((d) => d.date))}</p>
                </div>
                <StatusBadge status={r.status} />
              </div>
              <div className="flex items-center justify-between gap-3 text-sm">
                <LeaveTypeName leaveType={r.leaveType} />
                <span className="tabular-nums">{amount(r)}</span>
              </div>
              <ChainPosition request={r} />
            </Link>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              {showEmployee && <th className="py-2 pr-4 font-medium">Employee</th>}
              <th className="py-2 pr-4 font-medium">Dates</th>
              <th className="py-2 pr-4 font-medium">Type</th>
              <th className="py-2 pr-4 text-right font-medium">Amount</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 font-medium">Approval</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {requests.map((r) => (
              <tr key={r.id}>
                {showEmployee && (
                  <td className="py-2 pr-4 whitespace-nowrap">
                    {r.employee.firstName} {r.employee.lastName}
                  </td>
                )}
                <td className="py-2 pr-4">
                  <Link href={`/requests/${r.id}`} className="underline-offset-2 hover:underline">
                    {formatDateSpan(r.days.map((d) => d.date))}
                  </Link>
                </td>
                <td className="py-2 pr-4 whitespace-nowrap">
                  <LeaveTypeName leaveType={r.leaveType} />
                </td>
                <td className="py-2 pr-4 text-right tabular-nums whitespace-nowrap">{amount(r)}</td>
                <td className="py-2 pr-4">
                  <StatusBadge status={r.status} />
                </td>
                <td className="py-2">
                  <ChainPosition request={r} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

export function StatusBadge({ status }: { status: keyof typeof REQUEST_STATUS_LABEL }) {
  return (
    <span
      className={`inline-block shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${statusTone(status)}`}
    >
      {REQUEST_STATUS_LABEL[status]}
    </span>
  )
}

export function LeaveTypeName({ leaveType }: { leaveType: { name: string; colorHex: string } }) {
  return (
    <span className="whitespace-nowrap">
      <span
        aria-hidden
        className="mr-1.5 inline-block h-2 w-2 rounded-full"
        style={{ backgroundColor: leaveType.colorHex }}
      />
      {leaveType.name}
    </span>
  )
}

/**
 * Where a request stands in its chain: a dot per step, then who it is waiting
 * on while it is open. The dots show a decided request's path too — which
 * steps approved, which were skipped, where a denial came from.
 */
export function ChainPosition({
  request,
}: {
  request: Pick<RequestListItem, 'status' | 'steps'>
}) {
  const current = request.status === 'PENDING' ? currentStep(request.steps) : null
  const waiting = waitingOn(request)

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {request.steps.length > 0 && (
        <ol className="flex items-center gap-1" aria-label="Approval steps">
          {request.steps.map((step) => {
            const who = step.approver
              ? `${step.approver.firstName} ${step.approver.lastName}`
              : 'Any administrator'
            const isCurrent = step.id === current?.id
            const label = `Step ${step.step}, ${who}: ${isCurrent ? 'waiting' : STEP_STATUS_LABEL[step.status]}`
            return (
              <li key={step.id} title={label}>
                <span className="sr-only">{label}</span>
                <span aria-hidden className={`block h-2.5 w-2.5 rounded-full ${stepTone(step.status, isCurrent)}`} />
              </li>
            )
          })}
        </ol>
      )}
      {waiting && <span className="text-xs text-muted">{waiting}</span>}
    </div>
  )
}

function stepTone(status: keyof typeof STEP_STATUS_LABEL, isCurrent: boolean): string {
  if (isCurrent) return 'bg-accent ring-2 ring-accent/30'
  switch (status) {
    case 'APPROVED':
      return 'bg-green-600 dark:bg-green-400'
    case 'DENIED':
      return 'bg-danger'
    case 'SKIPPED':
      return 'border border-muted'
    default:
      return 'border border-border bg-border'
  }
}
