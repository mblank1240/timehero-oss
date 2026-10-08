import Link from 'next/link'
import { notFound } from 'next/navigation'

import { ConfigForm, Field, SubmitButton } from '@/components/form'
import { StatusBadge } from '@/components/request-table'
import { todayIn } from '@/lib/accrual/dates'
import { requireUser } from '@/lib/authz'
import { db } from '@/lib/db'
import { formatDuration } from '@/lib/duration'
import { orgSettingsOrThrow } from '@/lib/ledger/policies'
import {
  approveRequest,
  cancelRequest,
  denyRequest,
  overrideApproveRequest,
  overrideDenyRequest,
  overrideSkipStep,
  rerouteRequest,
} from '@/lib/requests/actions'
import { currentStep, mayDecide } from '@/lib/requests/chain'
import {
  STEP_STATUS_LABEL,
  formatDateSpan,
  formatLeaveDate,
  formatTimestamp,
} from '@/lib/requests/format'
import { canView, requestDetail } from '@/lib/requests/queries'

export const metadata = { title: 'Leave request · TimeHero' }

export default async function RequestPage({ params }: PageProps<'/requests/[id]'>) {
  const { id } = await params
  const user = await requireUser()
  const request = await requestDetail(id)

  // Not "forbidden": a request someone may not see is one that, to them,
  // does not exist (rule 8).
  if (!request || !canView(user, request)) notFound()

  const org = await orgSettingsOrThrow()
  const today = todayIn(org.timezone)
  const entries = await db.ledgerEntry.findMany({
    where: { sourceType: 'LeaveRequest', sourceId: request.id },
    select: { id: true, effectiveDate: true, minutes: true, kind: true, note: true },
    orderBy: [{ effectiveDate: 'asc' }, { createdAt: 'asc' }],
  })

  const show = (minutes: number) =>
    formatDuration(minutes, {
      unit: org.displayUnit,
      minutesPerDay: request.employee.standardMinutesPerDay,
    })

  const own = user.id === request.employeeId
  const isAdmin = user.role === 'ADMIN'
  const current = request.status === 'PENDING' ? currentStep(request.steps) : null
  const canDecide = current !== null && mayDecide(current, user, request.employeeId)
  const canOverride = current !== null && isAdmin && !own && !canDecide

  const started = request.days.some((d) => d.date <= today)
  const cancellable =
    (request.status === 'PENDING' || request.status === 'APPROVED') &&
    (own ? request.status === 'PENDING' || !started : isAdmin)

  const rerouteTargets = canOverride
    ? await db.employee.findMany({
        where: {
          isActive: true,
          id: { notIn: [request.employeeId, ...(current?.approverId ? [current.approverId] : [])] },
        },
        select: { id: true, firstName: true, lastName: true },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      })
    : []

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div className="space-y-2">
        <p className="text-sm">
          <Link
            href={own ? '/requests' : '/approvals'}
            className="text-muted hover:text-foreground"
          >
            ← {own ? 'My requests' : 'Approvals'}
          </Link>
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">
            {request.leaveType.name}
            {!own && (
              <span className="font-normal text-muted">
                {' '}
                for {request.employee.firstName} {request.employee.lastName}
              </span>
            )}
          </h1>
          <StatusBadge status={request.status} />
        </div>
        <p className="text-sm">
          {formatDateSpan(request.days.map((d) => d.date))} ·{' '}
          <span className="font-medium">{show(request.totalMinutes)}</span>
        </p>
        {request.submittedAt && (
          <p className="text-xs text-muted">
            Submitted {formatTimestamp(request.submittedAt, org.timezone)}
            {request.resolvedAt &&
              ` · ${request.status.toLowerCase()} ${formatTimestamp(request.resolvedAt, org.timezone)}`}
          </p>
        )}
        {request.note && <p className="th-card p-3 text-sm">{request.note}</p>}
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Days</h2>
        <ul className="th-card divide-y divide-border">
          {request.days.map((d) => (
            <li key={d.date.toISOString()} className="flex justify-between px-4 py-2 text-sm">
              <span>{formatLeaveDate(d.date)}</span>
              <span className="tabular-nums">{show(d.minutes)}</span>
            </li>
          ))}
        </ul>
      </section>

      {request.steps.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Approval</h2>
          <ol className="th-card divide-y divide-border">
            {request.steps.map((s) => {
              const who = s.approver
                ? `${s.approver.firstName} ${s.approver.lastName}`
                : 'Any administrator'
              const by =
                s.decidedBy && s.decidedBy.id !== s.approverId
                  ? ` by ${s.decidedBy.firstName} ${s.decidedBy.lastName}`
                  : ''
              return (
                <li key={s.id} className="space-y-0.5 px-4 py-2 text-sm">
                  <div className="flex flex-wrap justify-between gap-2">
                    <span>
                      <span className="text-muted">Step {s.step}:</span> {who}
                    </span>
                    <span
                      className={s.id === current?.id ? 'font-medium text-accent' : 'text-muted'}
                    >
                      {s.id === current?.id ? 'Waiting' : STEP_STATUS_LABEL[s.status]}
                      {by}
                      {s.decidedAt && ` · ${formatTimestamp(s.decidedAt, org.timezone)}`}
                    </span>
                  </div>
                  {s.comment && <p className="text-xs text-muted">“{s.comment}”</p>}
                </li>
              )
            })}
          </ol>
        </section>
      )}

      {entries.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Ledger</h2>
          <ul className="th-card divide-y divide-border">
            {entries.map((e) => (
              <li key={e.id} className="flex flex-wrap justify-between gap-2 px-4 py-2 text-sm">
                <span>
                  {formatLeaveDate(e.effectiveDate)}{' '}
                  <span className="text-muted">
                    {e.kind === 'USAGE' ? 'taken' : 'given back'}
                    {e.note ? ` · ${e.note}` : ''}
                  </span>
                </span>
                <span className="tabular-nums">
                  {e.minutes > 0 ? '+' : ''}
                  {show(e.minutes)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {canDecide && (
        <section className="space-y-4 border-t border-border pt-6">
          <h2 className="text-lg font-semibold">Your decision</h2>
          <div className="grid gap-6 sm:grid-cols-2">
            <ConfigForm action={approveRequest} successMessage="Approved.">
              <input type="hidden" name="requestId" value={request.id} />
              <Field label="Comment (optional)" name="comment">
                <input id="comment" name="comment" maxLength={500} className="th-input" />
              </Field>
              <SubmitButton label="Approve" pendingLabel="Approving…" />
            </ConfigForm>
            <ConfigForm action={denyRequest} successMessage="Denied.">
              <input type="hidden" name="requestId" value={request.id} />
              <Field label="Reason for denying (optional)" name="comment">
                <input id="deny-comment" name="comment" maxLength={500} className="th-input" />
              </Field>
              <SubmitButton label="Deny" pendingLabel="Denying…" />
            </ConfigForm>
          </div>
        </section>
      )}

      {canOverride && (
        <section className="space-y-4 border-t border-border pt-6">
          <div>
            <h2 className="text-lg font-semibold">Administrator override</h2>
            <p className="mt-1 text-sm text-muted">
              Step {current.step} is waiting on{' '}
              {current.approverId ? 'someone else' : 'any administrator'}. Each of these needs a
              reason, which is kept on the step and in the audit log.
            </p>
          </div>

          <ConfigForm action={overrideApproveRequest} successMessage="Step approved.">
            <input type="hidden" name="requestId" value={request.id} />
            <Field label="Reason for approving on their behalf" name="reason">
              <input
                id="approve-reason"
                name="reason"
                required
                minLength={5}
                className="th-input"
              />
            </Field>
            <SubmitButton label="Approve this step" pendingLabel="Approving…" />
          </ConfigForm>

          <ConfigForm action={overrideSkipStep} successMessage="Step skipped.">
            <input type="hidden" name="requestId" value={request.id} />
            <Field label="Reason for skipping" name="reason">
              <input id="skip-reason" name="reason" required minLength={5} className="th-input" />
            </Field>
            <SubmitButton label="Skip this step" pendingLabel="Skipping…" />
          </ConfigForm>

          <ConfigForm action={overrideDenyRequest} successMessage="Denied.">
            <input type="hidden" name="requestId" value={request.id} />
            <Field label="Reason for denying on their behalf" name="reason">
              <input id="deny-reason" name="reason" required minLength={5} className="th-input" />
            </Field>
            <SubmitButton label="Deny the request" pendingLabel="Denying…" />
          </ConfigForm>

          <ConfigForm action={rerouteRequest} successMessage="Rerouted.">
            <input type="hidden" name="requestId" value={request.id} />
            <Field label="Send this step to" name="approverId">
              <select id="approverId" name="approverId" required className="th-input">
                {rerouteTargets.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.lastName}, {e.firstName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Reason for rerouting" name="reason">
              <input
                id="reroute-reason"
                name="reason"
                required
                minLength={5}
                className="th-input"
              />
            </Field>
            <SubmitButton label="Reroute" pendingLabel="Rerouting…" />
          </ConfigForm>
        </section>
      )}

      {isAdmin && !own && (request.status === 'PENDING' || request.status === 'APPROVED') && (
        <section className="space-y-2 border-t border-border pt-6">
          <h2 className="text-lg font-semibold">Amend</h2>
          <p className="text-sm text-muted">
            Change the days, the amounts or the leave type.{' '}
            {request.status === 'APPROVED'
              ? 'It stays approved: the old days are given back and the new ones used, both in the ledger.'
              : 'It stays where it is in the approval chain.'}
          </p>
          <Link href={`/requests/${request.id}/amend`} className="th-btn-secondary inline-block">
            Amend this request
          </Link>
        </section>
      )}

      {cancellable && (
        <section className="space-y-4 border-t border-border pt-6">
          <div>
            <h2 className="text-lg font-semibold">Cancel</h2>
            <p className="mt-1 text-sm text-muted">
              {request.status === 'APPROVED'
                ? 'The time is given back to the balance. The original entries stay in the ledger, alongside the entries that return them.'
                : 'Nobody further will be asked to approve it.'}
            </p>
          </div>
          <ConfigForm action={cancelRequest} successMessage="Cancelled.">
            <input type="hidden" name="requestId" value={request.id} />
            {!own && (
              <Field label="Reason for cancelling" name="reason">
                <input
                  id="cancel-reason"
                  name="reason"
                  required
                  minLength={5}
                  className="th-input"
                />
              </Field>
            )}
            <SubmitButton label="Cancel request" pendingLabel="Cancelling…" />
          </ConfigForm>
        </section>
      )}
    </div>
  )
}
