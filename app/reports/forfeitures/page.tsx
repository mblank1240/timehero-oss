import { RangeFilters } from '@/components/report-filters'
import { todayIn } from '@/lib/accrual/dates'
import { formatDuration } from '@/lib/duration'
import { orgSettingsOrThrow } from '@/lib/ledger/policies'
import { forfeitureReport, reportLeaveTypes } from '@/lib/reports/data'
import { FORFEIT_REASON_LABEL } from '@/lib/reports/rows'
import { idParam, query, rangeParams } from '@/lib/reports/filters'
import { formatLeaveDate } from '@/lib/requests/format'

export const metadata = { title: 'Forfeitures · Reports · TimeHero' }

/**
 * Time lost: what the year-end rollover did not carry, and grants that
 * expired unspent — every FORFEIT in the ledger dated in the range.
 */
export default async function ForfeituresReportPage({
  searchParams,
}: PageProps<'/reports/forfeitures'>) {
  const params = await searchParams
  const org = await orgSettingsOrThrow()
  const range = rangeParams(params, org, todayIn(org.timezone))
  const type = idParam(params, 'type')
  const [rows, leaveTypes] = await Promise.all([
    forfeitureReport(range, type),
    reportLeaveTypes(),
  ])
  const show = (minutes: number, minutesPerDay: number) =>
    formatDuration(minutes, { unit: org.displayUnit, minutesPerDay })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Forfeitures</h1>
        <p className="mt-1 text-sm text-muted">
          Time the rollover did not carry into a new benefit year, and grants that expired before
          they were spent.
        </p>
      </div>

      <RangeFilters
        range={range}
        leaveTypes={leaveTypes}
        leaveTypeId={type}
        downloads={[
          {
            href: `/reports/export${query({ report: 'forfeitures', from: range.from, to: range.to, type })}`,
            label: 'Download (.csv)',
          },
        ]}
      />

      {rows.length === 0 ? (
        <p className="text-sm text-muted">Nothing was forfeited in that range.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="py-2 pr-4 font-medium">Date</th>
                <th className="py-2 pr-4 font-medium">Employee</th>
                <th className="py-2 pr-4 font-medium">Leave type</th>
                <th className="py-2 pr-4 font-medium">Reason</th>
                <th className="py-2 text-right font-medium">Forfeited</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="py-2 pr-4 whitespace-nowrap">{formatLeaveDate(r.date)}</td>
                  <td className="py-2 pr-4">
                    {r.employee.lastName}, {r.employee.firstName}
                  </td>
                  <td className="py-2 pr-4">{r.leaveType.name}</td>
                  <td className="py-2 pr-4">{FORFEIT_REASON_LABEL[r.reason]}</td>
                  <td className="py-2 text-right tabular-nums">
                    {show(r.minutes, r.employee.standardMinutesPerDay)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
