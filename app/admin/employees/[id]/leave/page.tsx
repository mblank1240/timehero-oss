import Link from 'next/link'
import { notFound } from 'next/navigation'

import { LeaveRequestForm } from '@/components/leave-request-form'
import { requirePermission } from '@/lib/authz'
import { db } from '@/lib/db'
import { leaveFormProps } from '@/lib/requests/form-props'

export const metadata = { title: 'Record leave · TimeHero' }

/**
 * An administrator entering leave for an employee — someone who called in
 * sick, or who does not use the app. It goes through their approval chain,
 * or is recorded as already approved.
 */
export default async function RecordLeavePage({ params }: PageProps<'/admin/employees/[id]/leave'>) {
  const admin = await requirePermission('MANAGE_TIME_RECORDS')
  const { id } = await params

  const employee = await db.employee.findUnique({
    where: { id },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      isActive: true,
      employmentType: true,
      standardMinutesPerDay: true,
    },
  })
  if (!employee || !employee.isActive || employee.id === admin.id) notFound()

  const props = await leaveFormProps(employee)
  const name = `${employee.firstName} ${employee.lastName}`

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <Link href={`/admin/employees/${employee.id}`} className="text-sm text-muted hover:underline">
          ← Back to {name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Record leave for {name}</h1>
        <p className="mt-1 text-sm text-muted">
          The same rules as their own request form: their balance, their working day, the
          organization&rsquo;s increments. The reason is kept in the audit log.
        </p>
      </div>

      <LeaveRequestForm
        {...props}
        admin={{ mode: 'record', employeeId: employee.id, employeeName: name }}
      />
    </div>
  )
}
