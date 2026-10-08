import { Downloads } from '@/components/report-filters'
import { formatDuration } from '@/lib/duration'
import { orgSettingsOrThrow } from '@/lib/ledger/policies'
import { employeeLedgerReport, reportEmployees, reportLeaveTypes } from '@/lib/reports/data'
import { idParam, query } from '@/lib/reports/filters'
import { LEDGER_KIND_LABEL } from '@/lib/reports/rows'
import { formatLeaveDate } from '@/lib/requests/format'

export const metadata = { title: 'Employee ledger · Reports · TimeHero' }

/**
 * Every ledger entry for one employee, oldest first, with each leave type's
 * running balance — the whole story of how a balance got where it is.
 * Read-only; an administrator corrects a balance under Administration →
 * Ledger.
 */
export default async function LedgerReportPage({ searchParams }: PageProps<'/reports/ledger'>) {
  const params = await searchParams
  const [org, employees, leaveTypes] = await Promise.all([
    orgSettingsOrThrow(),
    reportEmployees(),
    reportLeaveTypes(),
  ])
  const requested = idParam(params, 'employee')
  const type = idParam(params, 'type')
  const employee = employees.find((e) => e.id === requested) ?? null
  const lines = employee ? await employeeLedgerReport(employee.id, type) : []
  const show = (minutes: number) =>
    formatDuration(minutes, {
      unit: org.displayUnit,
      minutesPerDay: employee?.standardMinutesPerDay ?? 480,
    })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Employee ledger</h1>
        <p className="mt-1 text-sm text-muted">
          Every grant, accrual, use, rollover, forfeit and adjustment for one person, with the
          balance after each.
        </p>
      </div>

      <form className="flex flex-wrap items-end gap-3">
        <div className="min-w-56">
          <label htmlFor="employee" className="th-label">
            Employee
          </label>
          <select id="employee" name="employee" defaultValue={employee?.id ?? ''} className="th-input">
            <option value="" disabled>
              Choose someone
            </option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.lastName}, {e.firstName}
                {e.isActive ? '' : ' (inactive)'}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="type" className="th-label">
            Leave type
          </label>
          <select id="type" name="type" defaultValue={type ?? ''} className="th-input">
            <option value="">All types</option>
            {leaveTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="th-btn-secondary">
          Show
        </button>
        {employee && (
          <Downloads
            links={[
              {
                href: `/reports/export${query({ report: 'ledger', employee: employee.id, type })}`,
                label: 'Download (.csv)',
              },
            ]}
          />
        )}
      </form>

      {!employee ? (
        <p className="text-sm text-muted">Choose an employee to see their ledger.</p>
      ) : lines.length === 0 ? (
        <p className="text-sm text-muted">No entries.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="py-2 pr-4 font-medium">Date</th>
                <th className="py-2 pr-4 font-medium">Leave type</th>
                <th className="py-2 pr-4 font-medium">Entry</th>
                <th className="py-2 pr-4 text-right font-medium">Change</th>
                <th className="py-2 pr-4 text-right font-medium">Balance</th>
                <th className="py-2 font-medium">Note</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {lines.map((l) => (
                <tr key={l.id}>
                  <td className="py-2 pr-4 whitespace-nowrap">{formatLeaveDate(l.date)}</td>
                  <td className="py-2 pr-4">{l.leaveType.name}</td>
                  <td className="py-2 pr-4">{LEDGER_KIND_LABEL[l.kind]}</td>
                  <td
                    className={`py-2 pr-4 text-right tabular-nums ${l.minutes < 0 ? 'text-danger' : ''}`}
                  >
                    {l.minutes > 0 ? '+' : ''}
                    {show(l.minutes)}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">{show(l.balance)}</td>
                  <td className="py-2 text-xs text-muted">
                    {[
                      l.note,
                      l.expiresOn && `expires ${formatLeaveDate(l.expiresOn)}`,
                      l.createdBy && `by ${l.createdBy}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
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
