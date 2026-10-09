import Link from 'next/link'

import { LeaveTypeName } from '@/components/request-table'
import { todayIn } from '@/lib/accrual/dates'
import { requireUser } from '@/lib/authz'
import { leaveSummariesFor, type LeaveTypeSummary } from '@/lib/dashboard/queries'
import { db } from '@/lib/db'
import { formatDuration } from '@/lib/duration'
import { orgSettingsOrThrow } from '@/lib/ledger/policies'
import { formatDateSpan, formatLeaveDate } from '@/lib/requests/format'
import { requestStatusCounts, upcomingFor } from '@/lib/requests/queries'

export default async function DashboardPage() {
  const user = await requireUser()
  const org = await orgSettingsOrThrow()
  const today = todayIn(org.timezone)

  const [summaries, upcoming, counts, chain] = await Promise.all([
    leaveSummariesFor(user, org, today),
    upcomingFor(user.id, today),
    requestStatusCounts(user.id),
    db.approvalChainStep.findMany({
      where: { employeeId: user.id },
      orderBy: { step: 'asc' },
      select: {
        step: true,
        approver: { select: { firstName: true, lastName: true } },
      },
    }),
  ])

  const show = (minutes: number) =>
    formatDuration(minutes, { unit: org.displayUnit, minutesPerDay: user.standardMinutesPerDay })
  const pendingCount = counts.get('PENDING') ?? 0

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Welcome, {user.firstName}</h1>
          <p className="mt-1 text-sm text-muted">Balances as of {formatLeaveDate(today)}.</p>
        </div>
        <Link href="/requests/new" className="th-btn">
          Request time off
        </Link>
      </div>

      <section aria-labelledby="balances-heading" className="space-y-3">
        <h2 id="balances-heading" className="text-lg font-semibold">
          Your balances
        </h2>
        {summaries.length === 0 ? (
          <p className="text-sm text-muted">No leave types are set up yet.</p>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {summaries.map((summary) => (
              <BalanceCard key={summary.id} summary={summary} show={show} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="upcoming-heading" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="upcoming-heading" className="text-lg font-semibold">
            Upcoming time off
          </h2>
          <Link href="/history" className="text-sm text-accent underline-offset-2 hover:underline">
            See your history
          </Link>
        </div>
        {upcoming.length === 0 ? (
          <p className="text-sm text-muted">No approved time off coming up.</p>
        ) : (
          <ul className="th-card divide-y divide-border">
            {upcoming.map((request) => (
              <li key={request.id}>
                <Link
                  href={`/requests/${request.id}`}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm hover:bg-background"
                >
                  <span className="font-medium">
                    {formatDateSpan(request.days.map((d) => d.date))}
                  </span>
                  <span className="flex items-center gap-4">
                    <LeaveTypeName leaveType={request.leaveType} />
                    <span className="tabular-nums text-muted">{show(request.totalMinutes)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {pendingCount > 0 && (
          <p className="text-sm">
            <Link
              href="/requests?status=PENDING"
              className="text-accent underline-offset-2 hover:underline"
            >
              {pendingCount === 1
                ? '1 request is waiting for approval'
                : `${pendingCount} requests are waiting for approval`}
            </Link>
          </p>
        )}
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="th-card p-5">
          <h2 className="text-sm font-semibold">Your record</h2>
          <dl className="mt-3 space-y-1 text-sm">
            <Row label="Email" value={user.email} />
            <Row label="Access" value={user.accessRoleName ?? 'Employee'} />
            <Row
              label="Employment type"
              value={user.employmentType === 'HOURLY' ? 'Hourly' : 'Salaried (exempt)'}
            />
            <Row
              label="Standard day"
              value={formatDuration(user.standardMinutesPerDay, {
                unit: 'HOURS',
                minutesPerDay: user.standardMinutesPerDay,
              })}
            />
          </dl>
        </section>

        <section className="th-card p-5">
          <h2 className="text-sm font-semibold">Your approval chain</h2>
          {chain.length === 0 ? (
            <p className="mt-2 text-sm text-muted">
              No chain is configured, so requests will go to all administrators.
            </p>
          ) : (
            <ol className="mt-3 space-y-1 text-sm">
              {chain.map((step) => (
                <li key={step.step}>
                  <span className="text-muted">Step {step.step}:</span>{' '}
                  {step.approver.firstName} {step.approver.lastName}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  )
}

function BalanceCard({
  summary,
  show,
}: {
  summary: LeaveTypeSummary
  show: (minutes: number) => string
}) {
  return (
    <li className="th-card flex flex-col p-5" aria-label={`${summary.name} balance`}>
      <LeaveTypeName leaveType={summary} />
      <p className="mt-2 text-3xl font-semibold tabular-nums">{show(summary.balanceMinutes)}</p>

      <dl className="mt-4 space-y-1 text-sm">
        {summary.bookedMinutes !== 0 && (
          <Row label="Booked ahead" value={show(summary.bookedMinutes)} />
        )}
        <div className="flex justify-between gap-4">
          <dt className="text-muted">Pending approval</dt>
          <dd className="font-medium tabular-nums">
            {summary.pendingMinutes > 0 ? (
              <Link
                href={`/requests?status=PENDING&type=${summary.id}`}
                className="text-accent underline-offset-2 hover:underline"
              >
                {show(summary.pendingMinutes)}
              </Link>
            ) : (
              show(0)
            )}
          </dd>
        </div>
        <Row
          label="Next accrual"
          value={
            summary.nextAccrual
              ? `${show(summary.nextAccrual.minutes)} on ${shortDate(summary.nextAccrual.date)}`
              : 'None scheduled'
          }
        />
      </dl>

      {summary.loss && (
        <p
          role="note"
          className="mt-4 rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
        >
          {show(summary.loss.minutes)} will be forfeited on {shortDate(summary.loss.date)} unless
          used by {shortDate(summary.loss.usableThrough)}.
        </p>
      )}
    </li>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-medium tabular-nums">{value}</dd>
    </div>
  )
}

/** "Oct 15, 2026" — a DATE value, so read in UTC (see `formatLeaveDate`). */
function shortDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}
