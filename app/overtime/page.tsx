import Link from 'next/link'

import { OvertimeTable } from '@/components/overtime-table'
import { requireUser } from '@/lib/authz'
import { orgSettingsOrThrow } from '@/lib/ledger/policies'
import { overtimeFor } from '@/lib/overtime/queries'
import { overtimeAvailability } from '@/lib/overtime/service'

export const metadata = { title: 'Overtime · TimeHero' }

/**
 * An exempt employee's overtime logs. Anyone else is told why there is
 * nothing here for them rather than shown a 404 — the page is linked only
 * for exempt staff, but a bookmark should still explain itself.
 */
export default async function OvertimePage() {
  const user = await requireUser()
  const [org, availability, logs] = await Promise.all([
    orgSettingsOrThrow(),
    overtimeAvailability(user.employmentType),
    overtimeFor(user.id),
  ])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Overtime</h1>
          <p className="mt-1 text-sm text-muted">
            {availability.ok
              ? `Time you have worked beyond your normal hours. Once approved it is banked as ${availability.leaveTypeName}, which you spend like any other leave.`
              : availability.reason}
          </p>
        </div>
        {availability.ok && (
          <Link href="/overtime/new" className="th-btn">
            Log overtime
          </Link>
        )}
      </div>

      {(availability.ok || logs.length > 0) && (
        <OvertimeTable logs={logs} unit={org.displayUnit} empty="You have not logged any overtime." />
      )}
    </div>
  )
}
