import Link from 'next/link'
import { notFound } from 'next/navigation'

import { LeaveRequestForm } from '@/components/leave-request-form'
import { requirePermission } from '@/lib/authz'
import { db } from '@/lib/db'
import { leaveFormProps } from '@/lib/requests/form-props'

export const metadata = { title: 'Amend leave request · TimeHero' }

const iso = (date: Date) => date.toISOString().slice(0, 10)
const MS_PER_DAY = 86_400_000

/**
 * An administrator changing a pending or approved request. Their own requests
 * are not amendable here — they cancel and request again like anyone else.
 */
export default async function AmendRequestPage({ params }: PageProps<'/requests/[id]/amend'>) {
  const { id } = await params
  const admin = await requirePermission('MANAGE_TIME_RECORDS')

  const request = await db.leaveRequest.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      leaveTypeId: true,
      note: true,
      employeeId: true,
      employee: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          employmentType: true,
          standardMinutesPerDay: true,
        },
      },
      days: { select: { date: true, minutes: true }, orderBy: { date: 'asc' } },
    },
  })
  if (!request || request.employeeId === admin.id) notFound()
  if (request.status !== 'PENDING' && request.status !== 'APPROVED') notFound()

  const props = await leaveFormProps(request.employee)
  const start = iso(request.days[0].date)
  const end = iso(request.days[request.days.length - 1].date)
  const minutes: Record<string, number> = {}
  for (let t = Date.parse(start); t <= Date.parse(end); t += MS_PER_DAY) {
    minutes[new Date(t).toISOString().slice(0, 10)] = 0
  }
  for (const day of request.days) minutes[iso(day.date)] = day.minutes

  const name = `${request.employee.firstName} ${request.employee.lastName}`

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <Link href={`/requests/${request.id}`} className="text-sm text-muted hover:underline">
          ← Back to the request
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Amend {name}&rsquo;s request</h1>
        <p className="mt-1 text-sm text-muted">
          {request.status === 'APPROVED'
            ? 'It stays approved. The old days are given back and the new ones used; both show in the ledger.'
            : 'It stays where it is in the approval chain.'}{' '}
          The reason is kept in the audit log.
        </p>
      </div>

      <LeaveRequestForm
        {...props}
        admin={{
          mode: 'amend',
          employeeId: request.employee.id,
          employeeName: name,
          requestId: request.id,
          approved: request.status === 'APPROVED',
        }}
        initial={{ leaveTypeId: request.leaveTypeId, start, end, minutes, note: request.note ?? '' }}
      />
    </div>
  )
}
