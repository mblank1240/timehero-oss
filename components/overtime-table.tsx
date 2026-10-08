import Link from 'next/link'

import { ChainPosition, StatusBadge } from '@/components/request-table'
import { formatDuration, type DisplayUnit } from '@/lib/duration'
import type { OvertimeListItem } from '@/lib/overtime/queries'
import { formatLeaveDate } from '@/lib/requests/format'

/**
 * A list of overtime logs, laid out like `RequestTable`: a table from the
 * small breakpoint up, a card per log below it.
 *
 * Time worked is always shown in hours and minutes, whatever the org's
 * display unit — it is time on a clock, not leave. What was banked follows
 * the display unit, because it is now a leave balance.
 */
export function OvertimeTable({
  logs,
  unit,
  showEmployee = false,
  empty,
}: {
  logs: OvertimeListItem[]
  unit: DisplayUnit
  showEmployee?: boolean
  empty: string
}) {
  if (logs.length === 0) return <p className="text-sm text-muted">{empty}</p>

  const worked = (l: OvertimeListItem) =>
    formatDuration(l.minutes, { unit: 'HOURS', minutesPerDay: l.employee.standardMinutesPerDay })
  const banked = (l: OvertimeListItem) =>
    l.earnedMinutes === null
      ? '—'
      : formatDuration(l.earnedMinutes, { unit, minutesPerDay: l.employee.standardMinutesPerDay })

  return (
    <>
      <ul className="th-card divide-y divide-border sm:hidden">
        {logs.map((l) => (
          <li key={l.id}>
            <Link href={`/overtime/${l.id}`} className="block space-y-2 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  {showEmployee && (
                    <p className="text-sm font-medium">
                      {l.employee.firstName} {l.employee.lastName}
                    </p>
                  )}
                  <p className="text-sm">{formatLeaveDate(l.date)}</p>
                </div>
                <StatusBadge status={l.status} />
              </div>
              <div className="flex items-center justify-between gap-3 text-sm">
                <span>Worked {worked(l)}</span>
                {l.earnedMinutes !== null && <span className="tabular-nums">Banked {banked(l)}</span>}
              </div>
              <ChainPosition request={l} />
            </Link>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              {showEmployee && <th className="py-2 pr-4 font-medium">Employee</th>}
              <th className="py-2 pr-4 font-medium">Date worked</th>
              <th className="py-2 pr-4 text-right font-medium">Worked</th>
              <th className="py-2 pr-4 text-right font-medium">Banked</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 font-medium">Approval</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {logs.map((l) => (
              <tr key={l.id}>
                {showEmployee && (
                  <td className="py-2 pr-4 whitespace-nowrap">
                    {l.employee.firstName} {l.employee.lastName}
                  </td>
                )}
                <td className="py-2 pr-4">
                  <Link href={`/overtime/${l.id}`} className="underline-offset-2 hover:underline">
                    {formatLeaveDate(l.date)}
                  </Link>
                </td>
                <td className="py-2 pr-4 text-right tabular-nums whitespace-nowrap">{worked(l)}</td>
                <td className="py-2 pr-4 text-right tabular-nums whitespace-nowrap">{banked(l)}</td>
                <td className="py-2 pr-4">
                  <StatusBadge status={l.status} />
                </td>
                <td className="py-2">
                  <ChainPosition request={l} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
