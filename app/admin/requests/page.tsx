import { OvertimeTable } from '@/components/overtime-table'
import { RequestTable } from '@/components/request-table'
import { requirePermission } from '@/lib/authz'
import { orgSettingsOrThrow } from '@/lib/ledger/policies'
import { pendingOvertime } from '@/lib/overtime/queries'
import { pendingRequests } from '@/lib/requests/queries'

export const metadata = { title: 'Requests · TimeHero' }

/**
 * Every open request in the org. The way in to an override: an approver on
 * sabbatical, a step that needs skipping, a chain that has to be rerouted.
 */
export default async function AdminRequestsPage() {
  await requirePermission('VIEW_TIME_RECORDS')
  const [org, requests, overtime] = await Promise.all([
    orgSettingsOrThrow(),
    pendingRequests(),
    pendingOvertime(),
  ])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Open requests</h1>
        <p className="mt-1 text-sm text-muted">
          Every pending leave request and overtime log, oldest first. Open one to approve, skip or reroute the step it is
          waiting on — each needs a reason, and each is audit-logged.
        </p>
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Time off</h2>
        <RequestTable
          requests={requests}
          unit={org.displayUnit}
          showEmployee
          empty="No leave requests are waiting on anyone."
        />
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Overtime</h2>
        <OvertimeTable
          logs={overtime}
          unit={org.displayUnit}
          showEmployee
          empty="No overtime is waiting on anyone."
        />
      </section>
    </div>
  )
}
