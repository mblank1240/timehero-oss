import { LeaveRequestForm } from '@/components/leave-request-form'
import { requireUser } from '@/lib/authz'
import { leaveFormProps } from '@/lib/requests/form-props'

export const metadata = { title: 'Request time off · TimeHero' }

export default async function NewRequestPage() {
  const user = await requireUser()
  const props = await leaveFormProps(user)

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Request time off</h1>
        <p className="mt-1 text-sm text-muted">
          Choose the dates, then how much of each day you need. Your request goes to your approvers
          in order.
        </p>
      </div>

      <LeaveRequestForm {...props} />
    </div>
  )
}
