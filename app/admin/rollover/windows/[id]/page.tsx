import Link from 'next/link'
import { notFound } from 'next/navigation'

import { CarryoverWindowFields } from '@/components/config-fields'
import { ConfigForm, SubmitButton } from '@/components/form'
import { requirePermission } from '@/lib/authz'
import { saveCarryoverWindow } from '@/lib/config/actions'
import { db } from '@/lib/db'

export const metadata = { title: 'Edit carryover window · TimeHero' }

export default async function EditCarryoverWindowPage({
  params,
}: PageProps<'/admin/rollover/windows/[id]'>) {
  await requirePermission('MANAGE_POLICIES')
  const { id } = await params
  const window = await db.carryoverWindow.findUnique({
    where: { id },
    include: { leaveType: { select: { name: true } } },
  })
  if (!window) notFound()

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link href="/admin/rollover" className="text-sm text-muted hover:underline">
          ← Rollover
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">
          Edit {window.name} ({window.leaveType.name})
        </h1>
        <p className="mt-1 text-sm text-muted">
          Applies to rollovers and expiries not yet run. Carries already written stay as they are.
        </p>
      </div>
      <ConfigForm action={saveCarryoverWindow.bind(null, window.id)} successMessage="Saved.">
        <CarryoverWindowFields leaveTypeId={window.leaveTypeId} defaults={window} />
        <SubmitButton label="Save changes" />
      </ConfigForm>
    </div>
  )
}
