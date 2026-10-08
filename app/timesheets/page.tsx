import { TimesheetTable } from '@/components/timesheet-table'
import { requireUser } from '@/lib/authz'
import { timesheetsFor } from '@/lib/timesheets/queries'

export const metadata = { title: 'Timesheets · TimeHero' }

export default async function TimesheetsPage() {
  const user = await requireUser()
  const timesheets = await timesheetsFor(user.id)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Timesheets</h1>
        <p className="mt-1 text-sm text-muted">
          One for each pay period, newest first. Record the time you worked each day; approved
          leave and holidays are filled in for you.
        </p>
      </div>
      <TimesheetTable
        timesheets={timesheets}
        empty={
          user.employmentType === 'HOURLY'
            ? 'No timesheets yet. Yours appears once the pay period opens.'
            : 'Timesheets are for hourly staff, so you have none.'
        }
      />
    </div>
  )
}
