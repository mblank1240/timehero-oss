import { Downloads } from '@/components/report-filters'
import { todayIn } from '@/lib/accrual/dates'
import { requirePermission } from '@/lib/authz'
import { formatDuration } from '@/lib/duration'
import { orgSettingsOrThrow } from '@/lib/ledger/policies'
import { balancesReport } from '@/lib/reports/data'
import { dateParam, query } from '@/lib/reports/filters'

export const metadata = { title: 'Balances · Reports · TimeHero' }

/**
 * Every employee's balance in every leave type on one date — today by
 * default, or any date past or future. A future date counts only what is
 * already in the ledger, not accruals still to be written.
 */
export default async function BalancesReportPage({ searchParams }: PageProps<'/reports/balances'>) {
  await requirePermission('REPORT_BALANCES')
  const params = await searchParams
  const org = await orgSettingsOrThrow()
  const today = todayIn(org.timezone)
  const asOf = dateParam(params, 'asOf') ?? today
  const { leaveTypes, rows } = await balancesReport(asOf)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Balances</h1>
        <p className="mt-1 text-sm text-muted">
          Each balance is the sum of the ledger up to and including the date. A date ahead of
          today shows only what has already been recorded, not accruals still to come.
        </p>
      </div>

      <form className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="asOf" className="th-label">
            As of
          </label>
          <input
            id="asOf"
            name="asOf"
            type="date"
            defaultValue={asOf.toISOString().slice(0, 10)}
            className="th-input"
          />
        </div>
        <button type="submit" className="th-btn-secondary">
          Show
        </button>
        <Downloads
          links={[{ href: `/reports/export${query({ report: 'balances', asOf })}`, label: 'Download (.csv)' }]}
        />
      </form>

      {rows.length === 0 ? (
        <p className="text-sm text-muted">Nobody was employed on that date.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="py-2 pr-4 font-medium">Employee</th>
                {leaveTypes.map((t) => (
                  <th key={t.id} className="py-2 pr-4 text-right font-medium">
                    {t.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.employee.id}>
                  <td className="py-2 pr-4">
                    {r.employee.lastName}, {r.employee.firstName}
                  </td>
                  {leaveTypes.map((t) => {
                    const minutes = r.minutes.get(t.id) ?? 0
                    return (
                      <td
                        key={t.id}
                        className={`py-2 pr-4 text-right tabular-nums ${minutes === 0 ? 'text-muted' : ''} ${minutes < 0 ? 'text-danger' : ''}`}
                      >
                        {formatDuration(minutes, {
                          unit: org.displayUnit,
                          minutesPerDay: r.employee.standardMinutesPerDay,
                        })}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
