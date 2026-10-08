import { RangeFilters } from '@/components/report-filters'
import { todayIn } from '@/lib/accrual/dates'
import { formatDuration } from '@/lib/duration'
import { orgSettingsOrThrow } from '@/lib/ledger/policies'
import { leaveTakenReport, reportLeaveTypes } from '@/lib/reports/data'
import { idParam, query, rangeParams } from '@/lib/reports/filters'
import { formatLeaveDate } from '@/lib/requests/format'

export const metadata = { title: 'Leave taken · Reports · TimeHero' }

/**
 * Approved leave falling in a date range, per employee and leave type. Read
 * from the requests, as the history page is; leave recorded only as an
 * administrator's ledger adjustment is not a request and is not counted.
 */
export default async function LeaveTakenReportPage({ searchParams }: PageProps<'/reports/leave'>) {
  const params = await searchParams
  const org = await orgSettingsOrThrow()
  const range = rangeParams(params, org, todayIn(org.timezone))
  const type = idParam(params, 'type')
  const [{ days, summary }, leaveTypes] = await Promise.all([
    leaveTakenReport(range, type),
    reportLeaveTypes(),
  ])
  const filters = { from: range.from, to: range.to, type }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Leave taken</h1>
        <p className="mt-1 text-sm text-muted">
          Approved leave on days from {formatLeaveDate(range.from)} to {formatLeaveDate(range.to)}
          , including leave booked ahead. Cancelled and pending requests are not counted.
        </p>
      </div>

      <RangeFilters
        range={range}
        leaveTypes={leaveTypes}
        leaveTypeId={type}
        downloads={[
          { href: `/reports/export${query({ report: 'leave', ...filters })}`, label: 'Summary (.csv)' },
          { href: `/reports/export${query({ report: 'leave-days', ...filters })}`, label: 'Every day (.csv)' },
        ]}
      />

      {summary.length === 0 ? (
        <p className="text-sm text-muted">No approved leave in that range.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="py-2 pr-4 font-medium">Employee</th>
                <th className="py-2 pr-4 font-medium">Leave type</th>
                <th className="py-2 pr-4 text-right font-medium">Days</th>
                <th className="py-2 text-right font-medium">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {summary.map((r) => (
                <tr key={`${r.employee.id}:${r.leaveType.id}`}>
                  <td className="py-2 pr-4">
                    {r.employee.lastName}, {r.employee.firstName}
                  </td>
                  <td className="py-2 pr-4">{r.leaveType.name}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{r.days}</td>
                  <td className="py-2 text-right tabular-nums">
                    {formatDuration(r.minutes, {
                      unit: org.displayUnit,
                      minutesPerDay: r.employee.standardMinutesPerDay,
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted">
            {days.length} {days.length === 1 ? 'day' : 'days'} in all.
          </p>
        </div>
      )}
    </div>
  )
}
