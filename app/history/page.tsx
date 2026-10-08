import Link from 'next/link'

import { FilterChips } from '@/components/filter-chips'
import { LeaveHeatmap } from '@/components/leave-heatmap'
import { LeaveTypeName } from '@/components/request-table'
import {
  benefitYearContaining,
  benefitYearStartingIn,
  toUtcDay,
  todayIn,
} from '@/lib/accrual/dates'
import { requireUser } from '@/lib/authz'
import { db } from '@/lib/db'
import { formatDuration } from '@/lib/duration'
import { parseHistoryFilters } from '@/lib/history/filters'
import { buildHeatmap, groupUses } from '@/lib/history/heatmap'
import { approvedDaysFor } from '@/lib/history/queries'
import { orgSettingsOrThrow } from '@/lib/ledger/policies'
import { filterHref } from '@/lib/requests/filters'
import { formatLeaveDate } from '@/lib/requests/format'

export const metadata = { title: 'History · TimeHero' }

export default async function HistoryPage({ searchParams }: PageProps<'/history'>) {
  const user = await requireUser()
  const filters = parseHistoryFilters(await searchParams)
  const [org, days] = await Promise.all([orgSettingsOrThrow(), approvedDaysFor(user.id)])

  const today = todayIn(org.timezone)
  const startMonth = org.benefitYearStartMonth
  const startDay = org.benefitYearStartDay
  const yearOf = (date: Date) => benefitYearContaining(date, startMonth, startDay).label

  const types = new Map(
    (
      await db.leaveType.findMany({
        where: { id: { in: [...new Set(days.map((d) => d.leaveTypeId))] } },
        select: { id: true, name: true, colorHex: true },
        orderBy: { sortOrder: 'asc' },
      })
    ).map((t) => [t.id, t]),
  )

  // Every year with leave in it, plus the current one so a new employee sees
  // an empty grid rather than nothing at all. Newest first.
  const years = [...new Set([yearOf(today), ...days.map((d) => yearOf(d.date))])].sort(
    (a, b) => b - a,
  )
  const shown = filters.year !== undefined ? [filters.year] : years
  const matching = days.filter(
    (d) =>
      (!filters.type || d.leaveTypeId === filters.type) &&
      (filters.year === undefined || yearOf(d.date) === filters.year),
  )

  const show = (minutes: number) =>
    formatDuration(minutes, { unit: org.displayUnit, minutesPerDay: user.standardMinutesPerDay })
  const yearName = (label: number) => benefitYearName(label, startMonth, startDay)
  const href = (change: Record<string, string | number | undefined>) =>
    filterHref('/history', filters, change)
  const uses = groupUses(matching)

  const totals = [...types.values()]
    .map((type) => ({
      type,
      minutes: matching
        .filter((d) => d.leaveTypeId === type.id)
        .reduce((sum, d) => sum + d.minutes, 0),
    }))
    .filter((t) => t.minutes > 0)

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">History</h1>
        <p className="mt-1 text-sm text-muted">
          Every day of approved leave, past and scheduled. Darker squares are fuller days; hollow
          squares are leave still to come.
        </p>
      </div>

      <div className="space-y-3">
        {years.length > 1 && (
          <FilterChips
            label="Year"
            chips={[
              { label: 'All', href: href({ year: undefined }), active: filters.year === undefined },
              ...years.map((year) => ({
                label: yearName(year),
                href: href({ year }),
                active: filters.year === year,
              })),
            ]}
          />
        )}
        {types.size > 1 && (
          <FilterChips
            label="Type"
            chips={[
              { label: 'All', href: href({ type: undefined }), active: !filters.type },
              ...[...types.values()].map((type) => ({
                label: type.name,
                href: href({ type: type.id }),
                active: filters.type === type.id,
                colorHex: type.colorHex,
              })),
            ]}
          />
        )}
      </div>

      <section aria-label="Calendar" className="space-y-6">
        {shown.map((label) => {
          const year = benefitYearStartingIn(label, startMonth, startDay)
          const inYear = matching.filter((d) => yearOf(d.date) === label)
          const taken = inYear.reduce((sum, d) => sum + d.minutes, 0)
          const summary = `${yearName(label)}: ${taken > 0 ? `${show(taken)} of leave` : 'no leave'}`

          return (
            <div key={label} className="th-card space-y-2 p-4">
              <h2 className="flex flex-wrap items-baseline justify-between gap-2 text-sm font-semibold">
                <span>{yearName(label)}</span>
                <span className="font-normal text-muted">
                  {taken > 0 ? `${show(taken)} taken or booked` : 'No leave'}
                </span>
              </h2>
              <LeaveHeatmap
                heatmap={buildHeatmap(year, uses)}
                summary={summary}
                types={types}
                minutesPerDay={user.standardMinutesPerDay}
                today={today}
                show={show}
              />
            </div>
          )
        })}

        {types.size > 0 && (
          <ul aria-label="Legend" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            {[...types.values()].map((type) => (
              <li key={type.id}>
                <LeaveTypeName leaveType={type} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="days-heading" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="days-heading" className="text-lg font-semibold">
            Days
          </h2>
          {totals.length > 0 && (
            <p className="text-sm text-muted">
              {totals.map((t) => `${t.type.name} ${show(t.minutes)}`).join(' · ')}
            </p>
          )}
        </div>

        {matching.length === 0 ? (
          <p className="text-sm text-muted">
            {days.length === 0
              ? 'No approved leave yet.'
              : 'No approved leave matches these filters.'}
          </p>
        ) : (
          <div className="th-card overflow-x-auto px-4">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="py-2 pr-4 font-medium">Date</th>
                  <th className="py-2 pr-4 font-medium">Type</th>
                  <th className="py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {matching.map((day) => {
                  const type = types.get(day.leaveTypeId)
                  return (
                    <tr key={`${day.requestId}-${day.date.toISOString()}`}>
                      <td className="py-2 pr-4">
                        <Link
                          href={`/requests/${day.requestId}`}
                          className="underline-offset-2 hover:underline"
                        >
                          {formatLeaveDate(day.date)}
                        </Link>
                        {toUtcDay(day.date) > toUtcDay(today) && (
                          <span className="ml-2 text-xs text-muted">scheduled</span>
                        )}
                      </td>
                      <td className="py-2 pr-4">{type && <LeaveTypeName leaveType={type} />}</td>
                      <td className="py-2 text-right tabular-nums whitespace-nowrap">
                        {show(day.minutes)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

/** "2026" for a calendar benefit year, "2026–27" for one that straddles two. */
function benefitYearName(label: number, startMonth: number, startDay: number): string {
  if (startMonth === 1 && startDay === 1) return String(label)
  return `${label}–${String((label + 1) % 100).padStart(2, '0')}`
}
