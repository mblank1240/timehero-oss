import Link from 'next/link'

import { FilterChips } from '@/components/filter-chips'
import { RequestTable } from '@/components/request-table'
import { requireUser } from '@/lib/authz'
import { db } from '@/lib/db'
import { orgSettingsOrThrow } from '@/lib/ledger/policies'
import { LISTED_STATUSES, filterHref, parseRequestFilters } from '@/lib/requests/filters'
import { REQUEST_STATUS_LABEL } from '@/lib/requests/format'
import { requestStatusCounts, requestsFor } from '@/lib/requests/queries'

export const metadata = { title: 'My requests · TimeHero' }

export default async function MyRequestsPage({ searchParams }: PageProps<'/requests'>) {
  const user = await requireUser()
  const filters = parseRequestFilters(await searchParams)

  const [org, requests, counts, types] = await Promise.all([
    orgSettingsOrThrow(),
    requestsFor(user.id, filters),
    requestStatusCounts(user.id, filters.type),
    // Only types this employee has asked for — a filter that can only ever
    // come back empty is noise.
    db.leaveType.findMany({
      where: { leaveRequests: { some: { employeeId: user.id } } },
      select: { id: true, name: true, colorHex: true },
      orderBy: { sortOrder: 'asc' },
    }),
  ])

  const total = [...counts.values()].reduce((sum, n) => sum + n, 0)
  const href = (change: Record<string, string | undefined>) =>
    filterHref('/requests', filters, change)
  const filtered = filters.status !== undefined || filters.type !== undefined

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">My requests</h1>
          <p className="mt-1 text-sm text-muted">Everything you have asked for, newest first.</p>
        </div>
        <Link href="/requests/new" className="th-btn">
          Request time off
        </Link>
      </div>

      {total > 0 || filtered ? (
        <div className="space-y-3">
          <FilterChips
            label="Status"
            chips={[
              {
                label: 'All',
                href: href({ status: undefined }),
                active: !filters.status,
                count: total,
              },
              ...LISTED_STATUSES.map((status) => ({
                label: REQUEST_STATUS_LABEL[status],
                href: href({ status }),
                active: filters.status === status,
                count: counts.get(status) ?? 0,
              })),
            ]}
          />
          {types.length > 1 && (
            <FilterChips
              label="Type"
              chips={[
                { label: 'All', href: href({ type: undefined }), active: !filters.type },
                ...types.map((type) => ({
                  label: type.name,
                  href: href({ type: type.id }),
                  active: filters.type === type.id,
                  colorHex: type.colorHex,
                })),
              ]}
            />
          )}
        </div>
      ) : null}

      <RequestTable
        requests={requests}
        unit={org.displayUnit}
        empty={
          filtered
            ? 'No requests match these filters.'
            : 'You have not requested any time off yet.'
        }
      />
    </div>
  )
}
