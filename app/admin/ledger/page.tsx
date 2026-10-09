import Link from 'next/link'

import { ConfigForm, Field, SubmitButton } from '@/components/form'
import { requirePermission } from '@/lib/authz'
import { balancesAsOf } from '@/lib/ledger/balance'
import { createAdjustment } from '@/lib/ledger/actions'
import { accruableBy } from '@/lib/ledger/policies'
import { db } from '@/lib/db'
import { formatDuration } from '@/lib/duration'

export const metadata = { title: 'Ledger · TimeHero' }

/**
 * The ledger screen: balances, the entries behind them, and the one way a
 * human writes to the ledger directly.
 *
 * Every number on this page is derived — `SUM(minutes)` over the entries
 * listed below it, never a stored total. That is the point of the design, and
 * showing the sum next to its entries is what lets an administrator answer
 * "why is my PTO wrong?" without opening a database client.
 */
export default async function LedgerPage({ searchParams }: PageProps<'/admin/ledger'>) {
  await requirePermission('MANAGE_LEDGER')
  const params = await searchParams
  const selectedId = typeof params.employee === 'string' ? params.employee : undefined

  const [employees, leaveTypes, settings] = await Promise.all([
    db.employee.findMany({
      where: { isActive: true },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        standardMinutesPerDay: true,
        employmentType: true,
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    }),
    db.leaveType.findMany({
      where: { isActive: true },
      select: { id: true, name: true, code: true, accruableBy: true },
      orderBy: { sortOrder: 'asc' },
    }),
    db.orgSettings.findUnique({ where: { id: 1 } }),
  ])

  const employee = employees.find((e) => e.id === selectedId) ?? employees[0]

  // Comp time is for exempt staff only (rule 4), so offering it for an hourly
  // employee would be offering an adjustment the server is going to refuse.
  // The balances list still shows every type, because a balance of zero on a
  // type someone cannot hold is a true and useful thing to see.
  const adjustableTypes = employee
    ? leaveTypes.filter((t) => accruableBy(t.accruableBy, employee.employmentType))
    : []
  const unit = settings?.displayUnit ?? 'DAYS'
  const today = new Date()

  const [balances, entries] = employee
    ? await Promise.all([
        balancesAsOf(employee.id, today),
        db.ledgerEntry.findMany({
          where: { employeeId: employee.id },
          select: {
            id: true,
            effectiveDate: true,
            minutes: true,
            kind: true,
            expiresOn: true,
            periodKey: true,
            note: true,
            leaveType: { select: { name: true } },
            createdBy: { select: { firstName: true, lastName: true } },
          },
          orderBy: [{ effectiveDate: 'desc' }, { id: 'desc' }],
          take: 200,
        }),
      ])
    : [new Map<string, number>(), []]

  const minutesPerDay = employee?.standardMinutesPerDay ?? 480
  const show = (minutes: number) => formatDuration(minutes, { unit, minutesPerDay })
  const isoDate = (date: Date) => date.toISOString().slice(0, 10)

  return (
    <div className="mx-auto max-w-4xl space-y-10">
      <div>
        <h1 className="text-2xl font-semibold">Ledger</h1>
        <p className="mt-1 text-sm text-muted">
          Every balance here is the sum of the entries below it. Nothing is stored as a
          running total, and no entry is ever edited or deleted — a correction is a new
          entry.
        </p>
      </div>

      {employees.length === 0 ? (
        <p className="text-sm text-muted">
          No active employees yet. <Link href="/admin/employees" className="underline">Add one</Link>.
        </p>
      ) : (
        <>
          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Employee</h2>
            <form method="get" className="flex flex-wrap items-end gap-3">
              <div className="min-w-56 flex-1">
                <label htmlFor="employee" className="th-label">
                  Show the ledger for
                </label>
                <select
                  id="employee"
                  name="employee"
                  defaultValue={employee?.id}
                  className="th-input"
                >
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.lastName}, {e.firstName}
                    </option>
                  ))}
                </select>
              </div>
              <button type="submit" className="th-btn-secondary">
                Show
              </button>
            </form>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">
              Balances as of {isoDate(today)}
            </h2>
            <ul className="th-card divide-y divide-border">
              {leaveTypes.map((type) => (
                <li key={type.id} className="flex items-baseline justify-between py-2 first:pt-0 last:pb-0">
                  <span className="text-sm">{type.name}</span>
                  <span className="tabular-nums text-sm font-medium">
                    {show(balances.get(type.id) ?? 0)}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Entries</h2>
            {entries.length === 0 ? (
              <p className="text-sm text-muted">
                Nothing yet. Balances appear once an accrual job runs or an adjustment is
                posted.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-muted">
                    <tr>
                      <th className="py-2 pr-4 font-medium">Date</th>
                      <th className="py-2 pr-4 font-medium">Type</th>
                      <th className="py-2 pr-4 font-medium">Entry</th>
                      <th className="py-2 pr-4 text-right font-medium">Amount</th>
                      <th className="py-2 font-medium">Detail</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {entries.map((entry) => (
                      <tr key={entry.id}>
                        <td className="py-2 pr-4 tabular-nums whitespace-nowrap">
                          {isoDate(entry.effectiveDate)}
                        </td>
                        <td className="py-2 pr-4">{entry.leaveType.name}</td>
                        <td className="py-2 pr-4 whitespace-nowrap">
                          {entry.kind.toLowerCase().replace(/_/g, ' ')}
                        </td>
                        <td
                          className={`py-2 pr-4 text-right tabular-nums whitespace-nowrap ${
                            entry.minutes < 0 ? 'text-danger' : ''
                          }`}
                        >
                          {entry.minutes > 0 ? '+' : ''}
                          {show(entry.minutes)}
                        </td>
                        <td className="py-2 text-xs text-muted">
                          {[
                            entry.note,
                            entry.expiresOn ? `expires ${isoDate(entry.expiresOn)}` : null,
                            entry.periodKey,
                            entry.createdBy
                              ? `by ${entry.createdBy.firstName} ${entry.createdBy.lastName}`
                              : null,
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
          </section>

          <section className="space-y-4 border-t border-border pt-8">
            <div>
              <h2 className="text-lg font-semibold">Post an adjustment</h2>
              <p className="mt-1 text-sm text-muted">
                For opening balances, corrections and one-off awards. The reason is stored
                on the entry itself, so it is still there when nobody remembers the
                conversation.
              </p>
            </div>

            <ConfigForm action={createAdjustment} successMessage="Adjustment posted.">
              <input type="hidden" name="employeeId" value={employee?.id ?? ''} />

              <Field label="Employee" name="employeeId">
                <p className="text-sm">
                  {employee?.firstName} {employee?.lastName}
                </p>
              </Field>

              <Field label="Leave type" name="leaveTypeId">
                <select id="leaveTypeId" name="leaveTypeId" required className="th-input">
                  {adjustableTypes.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label="Effective date"
                name="effectiveDate"
                hint="The date the adjustment counts from, which drives balance-as-of queries."
              >
                <input
                  id="effectiveDate"
                  name="effectiveDate"
                  type="date"
                  required
                  defaultValue={isoDate(today)}
                  className="th-input"
                />
              </Field>

              <Field
                label="Minutes"
                name="minutes"
                hint="Signed and exact to the minute: 480 adds a standard day, -240 removes a half-day. The request increment does not apply to corrections."
              >
                <input
                  id="minutes"
                  name="minutes"
                  type="number"
                  step={1}
                  required
                  placeholder="480"
                  className="th-input"
                />
              </Field>

              <Field label="Reason" name="reason">
                <input
                  id="reason"
                  name="reason"
                  required
                  minLength={5}
                  maxLength={500}
                  placeholder="Opening balance imported from the spreadsheet"
                  className="th-input"
                />
              </Field>

              <SubmitButton label="Post adjustment" pendingLabel="Posting…" />
            </ConfigForm>
          </section>
        </>
      )}
    </div>
  )
}
