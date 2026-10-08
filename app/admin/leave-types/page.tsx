import Link from 'next/link'

import { ACCRUABLE_LABELS, LeaveTypeFields } from '@/components/config-fields'
import { ConfigForm, SubmitButton } from '@/components/form'
import { requireAdmin } from '@/lib/authz'
import { saveLeaveType } from '@/lib/config/actions'
import { db } from '@/lib/db'

export const metadata = { title: 'Leave types · TimeHero' }


export default async function LeaveTypesPage() {
  await requireAdmin()
  const types = await db.leaveType.findMany({
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { policies: true } } },
  })

  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <div>
        <h1 className="text-2xl font-semibold">Leave types</h1>
        <p className="mt-1 text-sm text-muted">
          Types are records, not fixed options — add bereavement or jury duty whenever
          policy calls for it, without a code change.
        </p>
      </div>

      <section className="space-y-3">
        {types.length === 0 ? (
          <p className="text-sm text-muted">None yet.</p>
        ) : (
          <ul className="th-card divide-y divide-border">
            {types.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                <span
                  aria-hidden
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: t.colorHex }}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">
                    {t.name}{' '}
                    <code className="text-xs font-normal text-muted">{t.code}</code>
                    {!t.isActive && <span className="ml-2 text-xs text-danger">· inactive</span>}
                  </div>
                  <div className="text-xs text-muted">
                    {ACCRUABLE_LABELS[t.accruableBy]} ·{' '}
                    {t.countsTowardRollover ? 'rolls over' : 'does not roll over'} ·{' '}
                    {t.requiresApproval ? 'needs approval' : 'no approval'} ·{' '}
                    {t._count.policies} {t._count.policies === 1 ? 'policy' : 'policies'}
                  </div>
                </div>
                <Link href={`/admin/leave-types/${t.id}`} className="text-sm text-accent hover:underline">
                  Edit<span className="sr-only"> {t.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-4 border-t border-border pt-8">
        <h2 className="text-lg font-semibold">Add a leave type</h2>
        <ConfigForm action={saveLeaveType.bind(null, null)} successMessage="Leave type added.">
          <LeaveTypeFields />

          <SubmitButton label="Add leave type" />
        </ConfigForm>
      </section>
    </div>
  )
}
