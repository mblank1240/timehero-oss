import Link from 'next/link'

import { TimesheetStatusBadge } from '@/components/timesheet-table'
import { todayIn } from '@/lib/accrual/dates'
import { requireReportsAccess } from '@/lib/authz'
import { db } from '@/lib/db'
import { formatDuration } from '@/lib/duration'
import { orgSettingsOrThrow } from '@/lib/ledger/policies'
import { formatLeaveDate } from '@/lib/requests/format'
import { TIMELINESS_LABEL, type Timeliness } from '@/lib/timesheets/due'
import { formatPeriod } from '@/lib/timesheets/format'
import { periodReport } from '@/lib/timesheets/report'

export const metadata = { title: 'Timesheets · Reports · TimeHero' }

/** How many past periods the picker offers. A display choice, not a policy. */
const PAST_PERIODS = 12

/**
 * Who has submitted for a pay period, and the exports payroll takes from it.
 * Defaults to the period open today on the default schedule. Read by
 * administrators and finance; the only action here is downloading.
 */
export default async function TimesheetReportPage({
  searchParams,
}: PageProps<'/reports/timesheets'>) {
  const user = await requireReportsAccess()
  const { period: requested } = await searchParams
  const org = await orgSettingsOrThrow()
  const today = todayIn(org.timezone)

  const schedules = await db.paySchedule.findMany({
    where: { isActive: true },
    select: { id: true, name: true, isDefault: true },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
  })

  const periods = (
    await Promise.all(
      schedules.map((s) =>
        db.payPeriod.findMany({
          where: { payScheduleId: s.id, startDate: { lte: today } },
          select: { id: true, startDate: true, endDate: true, payScheduleId: true },
          orderBy: { startDate: 'desc' },
          take: PAST_PERIODS,
        }),
      ),
    )
  ).flat()

  const chosen =
    (typeof requested === 'string' && periods.find((p) => p.id === requested)) || periods[0]
  const report = chosen ? await periodReport(chosen.id) : null
  const clock = (minutes: number) =>
    formatDuration(minutes, { unit: 'HOURS', minutesPerDay: 1 })
  const scheduleName = new Map(schedules.map((s) => [s.id, s.name]))

  const counts = new Map<string, number>()
  for (const r of report?.rows ?? []) {
    const key = r.status ?? 'MISSING'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Timesheets</h1>
        <p className="mt-1 text-sm text-muted">
          Every hourly employee due a timesheet for the pay period, and where theirs stands.
          Download one employee&apos;s timesheet from their row, or every one at once.
          {user.role === 'ADMIN' && ' Open one to approve it on someone’s behalf or unlock it.'}
        </p>
      </div>

      <form className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="period" className="th-label">
            Pay period
          </label>
          <select id="period" name="period" defaultValue={chosen?.id} className="th-input">
            {periods.map((p) => (
              <option key={p.id} value={p.id}>
                {schedules.length > 1 ? `${scheduleName.get(p.payScheduleId)}: ` : ''}
                {formatPeriod(p)}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="th-btn-secondary">
          Show
        </button>
        {report && (
          <>
            <a
              href={`/reports/timesheets/export?period=${report.period.id}&format=zip`}
              className="th-btn-secondary"
              download
            >
              Download all (.zip)
            </a>
            <a
              href={`/reports/timesheets/export?period=${report.period.id}`}
              className="th-btn-secondary"
              download
            >
              Summary (.csv)
            </a>
          </>
        )}
      </form>

      {!report ? (
        <p className="text-sm text-muted">No pay periods have started yet.</p>
      ) : (
        <section className="space-y-3">
          <p className="text-sm">
            {formatPeriod(report.period)} · due {formatLeaveDate(report.dueDate)} · paid{' '}
            {formatLeaveDate(report.period.payDate)}
            <span className="text-muted">
              {' · '}
              {counts.get('APPROVED') ?? 0} approved, {counts.get('SUBMITTED') ?? 0} waiting,{' '}
              {(counts.get('OPEN') ?? 0) + (counts.get('REJECTED') ?? 0)} not submitted
              {counts.get('MISSING') ? `, ${counts.get('MISSING')} not created` : ''}
            </span>
          </p>
          {counts.get('MISSING') ? (
            <p className="text-sm text-muted">
              A timesheet that has not been created appears once the{' '}
              {user.role === 'ADMIN' ? (
                <Link href="/admin/jobs" className="underline">
                  create-timesheets
                </Link>
              ) : (
                'create-timesheets'
              )}{' '}
              job runs for a date inside the period.
            </p>
          ) : null}

          {report.rows.length === 0 ? (
            <p className="text-sm text-muted">Nobody on this schedule keeps a timesheet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Employee</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium">Submitted</th>
                    <th className="py-2 pr-4 text-right font-medium">Regular</th>
                    <th className="py-2 pr-4 text-right font-medium">Overtime</th>
                    <th className="py-2 pr-4 text-right font-medium">Holiday</th>
                    <th className="py-2 pr-4 text-right font-medium">Leave</th>
                    <th className="py-2 font-medium">
                      <span className="sr-only">Download</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {report.rows.map((r) => (
                    <tr key={r.employee.id}>
                      <td className="py-2 pr-4">
                        {r.timesheetId ? (
                          <Link href={`/timesheets/${r.timesheetId}`} className="hover:underline">
                            {r.employee.lastName}, {r.employee.firstName}
                          </Link>
                        ) : (
                          `${r.employee.lastName}, ${r.employee.firstName}`
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        {r.status ? (
                          <TimesheetStatusBadge status={r.status} />
                        ) : (
                          <span className="text-xs text-muted">Not created</span>
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        {r.timeliness && <TimelinessText value={r.timeliness} />}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {r.totals ? clock(r.totals.regular) : '—'}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {r.totals ? clock(r.totals.overtime) : '—'}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {r.totals ? clock(r.totals.holiday) : '—'}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {r.totals ? clock(r.totals.leave) : '—'}
                      </td>
                      <td className="py-2 text-right">
                        {r.timesheetId && (
                          <a
                            href={`/reports/timesheets/export?timesheet=${r.timesheetId}`}
                            className="text-xs underline"
                            download
                            aria-label={`Download ${r.employee.firstName} ${r.employee.lastName}'s timesheet`}
                          >
                            CSV
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  )
}

function TimelinessText({ value }: { value: Timeliness }) {
  const tone =
    value === 'LATE' || value === 'OVERDUE'
      ? 'text-danger'
      : 'text-muted'
  return <span className={`text-xs ${tone}`}>{TIMELINESS_LABEL[value]}</span>
}
