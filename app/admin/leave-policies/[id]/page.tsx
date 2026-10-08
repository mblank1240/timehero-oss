import Link from 'next/link'
import { notFound } from 'next/navigation'

import { LeavePolicyFields } from '@/components/config-fields'
import { ConfigForm, SubmitButton } from '@/components/form'
import { saveLeavePolicy } from '@/lib/config/actions'
import { db } from '@/lib/db'

export const metadata = { title: 'Edit leave policy · TimeHero' }

export default async function EditLeavePolicyPage({
  params,
}: PageProps<'/admin/leave-policies/[id]'>) {
  const { id } = await params
  const [policy, types] = await Promise.all([
    db.leavePolicy.findUnique({
      where: { id },
      include: { leaveType: { select: { id: true, name: true } } },
    }),
    db.leaveType.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true },
    }),
  ])
  if (!policy) notFound()
  // Keep the policy's own type selectable even if it has since been retired.
  const choices = types.some((t) => t.id === policy.leaveTypeId)
    ? types
    : [policy.leaveType, ...types]

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link href="/admin/leave-policies" className="text-sm text-muted hover:underline">
          ← Leave policies
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">
          Edit {policy.leaveType.name} — {policy.name}
        </h1>
        <p className="mt-1 text-sm text-muted">
          Changes affect grants not yet made. Grants already on the ledger stay as written; correct
          one with a ledger adjustment. Untick Active to retire the policy.
        </p>
      </div>
      <ConfigForm action={saveLeavePolicy.bind(null, policy.id)} successMessage="Saved.">
        <LeavePolicyFields types={choices} defaults={policy} />
        <SubmitButton label="Save changes" />
      </ConfigForm>
    </div>
  )
}
