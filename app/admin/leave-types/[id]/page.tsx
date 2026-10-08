import Link from 'next/link'
import { notFound } from 'next/navigation'

import { LeaveTypeFields } from '@/components/config-fields'
import { ConfigForm, SubmitButton } from '@/components/form'
import { saveLeaveType } from '@/lib/config/actions'
import { db } from '@/lib/db'

export const metadata = { title: 'Edit leave type · TimeHero' }

export default async function EditLeaveTypePage({ params }: PageProps<'/admin/leave-types/[id]'>) {
  const { id } = await params
  const type = await db.leaveType.findUnique({ where: { id } })
  if (!type) notFound()

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link href="/admin/leave-types" className="text-sm text-muted hover:underline">
          ← Leave types
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Edit {type.name}</h1>
        <p className="mt-1 text-sm text-muted">
          Changes apply from now on. Balances already on the ledger stay as they are. Untick
          Active to retire a type without losing its history.
        </p>
      </div>
      <ConfigForm action={saveLeaveType.bind(null, type.id)} successMessage="Saved.">
        <LeaveTypeFields defaults={type} />
        <SubmitButton label="Save changes" />
      </ConfigForm>
    </div>
  )
}
