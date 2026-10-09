import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PayScheduleFields } from '@/components/config-fields'
import { ConfigForm, SubmitButton } from '@/components/form'
import { requirePermission } from '@/lib/authz'
import { savePaySchedule } from '@/lib/config/actions'
import { db } from '@/lib/db'

export const metadata = { title: 'Edit pay schedule · TimeHero' }

export default async function EditPaySchedulePage({
  params,
}: PageProps<'/admin/pay-schedules/[id]'>) {
  await requirePermission('MANAGE_POLICIES')
  const { id } = await params
  const schedule = await db.paySchedule.findUnique({ where: { id } })
  if (!schedule) notFound()

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link href="/admin/pay-schedules" className="text-sm text-muted hover:underline">
          ← Pay schedules
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Edit {schedule.name}</h1>
        <p className="mt-1 text-sm text-muted">
          Saving regenerates future, unlocked periods from these settings. Periods already past,
          or locked by a timesheet, never move.
        </p>
      </div>
      <ConfigForm
        action={savePaySchedule.bind(null, schedule.id)}
        successMessage="Saved, and future periods regenerated."
      >
        <PayScheduleFields defaults={schedule} />
        <SubmitButton label="Save changes" />
      </ConfigForm>
    </div>
  )
}
