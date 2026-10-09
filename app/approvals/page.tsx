import { OvertimeTable } from '@/components/overtime-table'
import { RequestTable } from '@/components/request-table'
import { TimesheetTable } from '@/components/timesheet-table'
import { requireUser } from '@/lib/authz'
import { orgSettingsOrThrow } from '@/lib/ledger/policies'
import { overtimeInboxFor } from '@/lib/overtime/queries'
import { inboxFor } from '@/lib/requests/queries'
import { timesheetInboxFor } from '@/lib/timesheets/queries'
import { can } from '@/lib/permissions'

export const metadata = { title: 'Approvals · TimeHero' }

/**
 * Requests waiting on the signed-in person right now. Anyone can be an
 * approver — it is a position in someone's chain, not a role — so this page
 * is open to every employee and simply empty for most of them.
 */
export default async function ApprovalsPage() {
  const user = await requireUser()
  const [org, requests, overtime, timesheets] = await Promise.all([
    orgSettingsOrThrow(),
    inboxFor(user),
    overtimeInboxFor(user),
    timesheetInboxFor(user),
  ])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Approvals</h1>
        <p className="mt-1 text-sm text-muted">
          Requests waiting on you, oldest first. Open one to approve or deny it.
          {can(user, 'MANAGE_TIME_RECORDS') &&
            ' Requests from anyone with no approval chain come to everyone who may act on others’ time records.'}
        </p>
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Time off</h2>
        <RequestTable
          requests={requests}
          unit={org.displayUnit}
          showEmployee
          empty="No leave requests are waiting on you."
        />
      </section>

      {/* Like overtime, only when there is some: most approvers have no hourly staff. */}
      {timesheets.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Timesheets</h2>
          <TimesheetTable timesheets={timesheets} showEmployee empty="" />
        </section>
      )}

      {/* Overtime is rare, so the section appears only when there is some. */}
      {overtime.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Overtime</h2>
          <OvertimeTable logs={overtime} unit={org.displayUnit} showEmployee empty="" />
        </section>
      )}
    </div>
  )
}
