import Link from 'next/link'

import { FIRST_YEAR_LABELS, LeavePolicyFields, METHOD_LABELS } from '@/components/config-fields'
import { ConfigForm, SubmitButton } from '@/components/form'
import { saveLeavePolicy } from '@/lib/config/actions'
import { db } from '@/lib/db'
import { formatDuration } from '@/lib/duration'

export const metadata = { title: 'Leave policies · TimeHero' }



export default async function LeavePoliciesPage() {
  const [policies, types, settings] = await Promise.all([
    db.leavePolicy.findMany({
      orderBy: [{ leaveType: { sortOrder: 'asc' } }, { name: 'asc' }],
      include: {
        leaveType: { select: { name: true, colorHex: true } },
        _count: { select: { assignments: true } },
      },
    }),
    db.leaveType.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true },
    }),
    db.orgSettings.findUnique({ where: { id: 1 } }),
  ])

  const unit = settings?.displayUnit ?? 'DAYS'

  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <div>
        <h1 className="text-2xl font-semibold">Leave policies</h1>
        <p className="mt-1 text-sm text-muted">
          A policy says how much time a leave type grants and when. Employees are
          assigned to one per type on their own record, optionally with a different
          allotment.
        </p>
      </div>

      <section className="space-y-3">
        {policies.length === 0 ? (
          <p className="text-sm text-muted">
            None yet. Add a leave type first, then a policy for it.
          </p>
        ) : (
          <ul className="th-card divide-y divide-border">
            {policies.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                <span
                  aria-hidden
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: p.leaveType.colorHex }}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">
                    {p.leaveType.name} — {p.name}
                    {!p.isActive && <span className="ml-2 text-xs text-danger">· inactive</span>}
                  </div>
                  <div className="text-xs text-muted">
                    {formatDuration(p.annualMinutes, { unit, minutesPerDay: 480 })} a year ·{' '}
                    {METHOD_LABELS[p.method]}
                    {p.waitingPeriodDays > 0 && ` · ${p.waitingPeriodDays}-day wait`}
                    {p.maxBalanceMinutes !== null &&
                      ` · ceiling ${formatDuration(p.maxBalanceMinutes, { unit, minutesPerDay: 480 })}`}
                  </div>
                  <div className="text-xs text-muted">
                    New hires: {FIRST_YEAR_LABELS[p.firstYearGrant].toLowerCase()} ·{' '}
                    {p._count.assignments}{' '}
                    {p._count.assignments === 1 ? 'employee' : 'employees'}
                  </div>
                </div>
                <Link href={`/admin/leave-policies/${p.id}`} className="text-sm text-accent hover:underline">
                  Edit<span className="sr-only"> {p.leaveType.name} {p.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-4 border-t border-border pt-8">
        <h2 className="text-lg font-semibold">Add a policy</h2>

        {types.length === 0 ? (
          <p className="text-sm text-muted">Create a leave type first.</p>
        ) : (
          <ConfigForm
            action={saveLeavePolicy.bind(null, null)}
            successMessage="Policy added."
          >
            <LeavePolicyFields types={types} />

            <SubmitButton label="Add policy" />
          </ConfigForm>
        )}
      </section>
    </div>
  )
}
