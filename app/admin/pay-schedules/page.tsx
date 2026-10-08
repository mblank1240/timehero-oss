import Link from 'next/link'

import { PAY_SCHEDULE_TYPE_LABELS, PayScheduleFields } from '@/components/config-fields'
import { ActionButton, ConfigForm, SubmitButton } from '@/components/form'
import { requireAdmin } from '@/lib/authz'
import { savePaySchedule, syncPayPeriods } from '@/lib/config/actions'
import { db } from '@/lib/db'
import { periodsPerYear } from '@/lib/payperiods/generate'

export const metadata = { title: 'Pay schedules · TimeHero' }


function fmt(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export default async function PaySchedulesPage() {
  await requireAdmin()
  const schedules = await db.paySchedule.findMany({
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    include: {
      _count: { select: { periods: true, employees: true } },
    },
  })

  const today = new Date()
  const upcoming = await db.payPeriod.findMany({
    where: { endDate: { gte: today } },
    orderBy: { startDate: 'asc' },
    take: 6,
    include: { paySchedule: { select: { name: true } } },
  })

  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <div>
        <h1 className="text-2xl font-semibold">Pay schedules</h1>
        <p className="mt-1 text-sm text-muted">
          Periods are generated 24 months ahead and stored, so accruals and timesheets
          reference fixed dates. Editing a schedule regenerates only future unlocked
          periods — history never moves.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Existing schedules</h2>
        {schedules.length === 0 ? (
          <p className="text-sm text-muted">None yet. Add one below.</p>
        ) : (
          <ul className="th-card divide-y divide-border">
            {schedules.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">
                    {s.name}
                    {s.isDefault && <span className="ml-2 text-xs text-muted">· default</span>}
                    {!s.isActive && <span className="ml-2 text-xs text-danger">· inactive</span>}
                  </div>
                  <div className="text-xs text-muted">
                    {PAY_SCHEDULE_TYPE_LABELS[s.type]} · {periodsPerYear(s.type)} periods a year · anchored{' '}
                    {fmt(s.anchorDate)} · paid {s.payDateOffsetDays} days after period end
                  </div>
                  <div className="text-xs text-muted">
                    {s._count.periods} periods generated · {s._count.employees} employees
                  </div>
                </div>
                <Link href={`/admin/pay-schedules/${s.id}`} className="text-sm text-accent hover:underline">
                  Edit<span className="sr-only"> {s.name}</span>
                </Link>
                <ActionButton
                  action={syncPayPeriods.bind(null, s.id)}
                  label="Regenerate periods"
                  pendingLabel="Regenerating…"
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {upcoming.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Next periods</h2>
          <div className="th-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Schedule</th>
                  <th className="px-4 py-2 font-medium">Start</th>
                  <th className="px-4 py-2 font-medium">End</th>
                  <th className="px-4 py-2 font-medium">Pay date</th>
                </tr>
              </thead>
              <tbody>
                {upcoming.map((p) => (
                  <tr key={p.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 text-muted">{p.paySchedule.name}</td>
                    <td className="px-4 py-2">{fmt(p.startDate)}</td>
                    <td className="px-4 py-2">{fmt(p.endDate)}</td>
                    <td className="px-4 py-2 text-muted">{fmt(p.payDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="space-y-4 border-t border-border pt-8">
        <h2 className="text-lg font-semibold">Add a schedule</h2>
        <ConfigForm
          action={savePaySchedule.bind(null, null)}
          successMessage="Schedule saved and periods generated."
        >
          <PayScheduleFields />

          <SubmitButton label="Create schedule" />
        </ConfigForm>
      </section>
    </div>
  )
}
