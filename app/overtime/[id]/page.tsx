import Link from 'next/link'
import { notFound } from 'next/navigation'

import { ConfigForm, Field, SubmitButton } from '@/components/form'
import { StatusBadge } from '@/components/request-table'
import { requireUser } from '@/lib/authz'
import { db } from '@/lib/db'
import { formatDuration } from '@/lib/duration'
import { orgSettingsOrThrow } from '@/lib/ledger/policies'
import {
  approveOvertime,
  cancelOvertime,
  denyOvertime,
  overrideApproveOvertime,
  overrideSkipOvertimeStep,
  rerouteOvertime,
} from '@/lib/overtime/actions'
import { canViewOvertime, overtimeDetail } from '@/lib/overtime/queries'
import { compPlanFor } from '@/lib/overtime/service'
import { currentStep, mayDecide } from '@/lib/requests/chain'
import { STEP_STATUS_LABEL, formatLeaveDate, formatTimestamp } from '@/lib/requests/format'

export const metadata = { title: 'Overtime · TimeHero' }

const multiplier = (bps: number) => `${(bps / 10_000).toString()}×`

export default async function OvertimeLogPage({ params }: PageProps<'/overtime/[id]'>) {
  const { id } = await params
  const user = await requireUser()
  const log = await overtimeDetail(id)

  // A log someone may not see does not exist, to them (rule 8).
  if (!log || !canViewOvertime(user, log)) notFound()

  const org = await orgSettingsOrThrow()
  const entries = await db.ledgerEntry.findMany({
    where: { sourceType: 'OvertimeLog', sourceId: log.id },
    select: {
      id: true,
      effectiveDate: true,
      minutes: true,
      expiresOn: true,
      note: true,
      leaveType: { select: { name: true } },
    },
    orderBy: [{ effectiveDate: 'asc' }, { createdAt: 'asc' }],
  })

  const minutesPerDay = log.employee.standardMinutesPerDay
  const clock = (minutes: number) => formatDuration(minutes, { unit: 'HOURS', minutesPerDay })
  const show = (minutes: number) => formatDuration(minutes, { unit: org.displayUnit, minutesPerDay })

  const own = user.id === log.employeeId
  const isAdmin = user.role === 'ADMIN'
  const current = log.status === 'PENDING' ? currentStep(log.steps) : null
  const canDecide = current !== null && mayDecide(current, user, log.employeeId)
  const canOverride = current !== null && isAdmin && !own && !canDecide
  const cancellable =
    (log.status === 'PENDING' && (own || isAdmin)) ||
    (log.status === 'APPROVED' && isAdmin && !own)

  // What approving now would bank, so nobody approves a closed-year log
  // believing it banks the full amount.
  const plan = log.status === 'PENDING' ? await compPlanFor(log) : null
  const planExpiry = plan?.entries.find((e) => e.expiresOn)?.expiresOn ?? null

  const rerouteTargets = canOverride
    ? await db.employee.findMany({
        where: {
          isActive: true,
          id: { notIn: [log.employeeId, ...(current?.approverId ? [current.approverId] : [])] },
        },
        select: { id: true, firstName: true, lastName: true },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      })
    : []

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div className="space-y-2">
        <p className="text-sm">
          <Link href={own ? '/overtime' : '/approvals'} className="text-muted hover:text-foreground">
            ← {own ? 'Overtime' : 'Approvals'}
          </Link>
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">
            Overtime
            {!own && (
              <span className="font-normal text-muted">
                {' '}
                for {log.employee.firstName} {log.employee.lastName}
              </span>
            )}
          </h1>
          <StatusBadge status={log.status} />
        </div>
        <p className="text-sm">
          {formatLeaveDate(log.date)} · worked <span className="font-medium">{clock(log.minutes)}</span>
          {log.earnedMinutes !== null && log.multiplierBps !== null && (
            <>
              {' '}
              · banked <span className="font-medium">{show(log.earnedMinutes)}</span> at{' '}
              {multiplier(log.multiplierBps)}
            </>
          )}
        </p>
        <p className="text-xs text-muted">
          Submitted {formatTimestamp(log.submittedAt, org.timezone)}
          {log.resolvedAt &&
            ` · ${log.status.toLowerCase()} ${formatTimestamp(log.resolvedAt, org.timezone)}`}
        </p>
        <p className="th-card p-3 text-sm">{log.note}</p>
      </div>

      {plan && (
        <section className="space-y-1">
          <h2 className="text-lg font-semibold">If approved</h2>
          <p className="text-sm">
            Banks <span className="font-medium">{show(plan.earnedMinutes)}</span>
            {plan.earnedMinutes !== log.minutes &&
              ` (${clock(log.minutes)} at ${multiplier(org.compTimeMultiplierBps)})`}
            {planExpiry && `, usable until ${formatLeaveDate(planExpiry)}`}
            .
          </p>
          {plan.explanation && <p className="text-sm text-muted">{plan.explanation}</p>}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Approval</h2>
        <ol className="th-card divide-y divide-border">
          {log.steps.map((s) => {
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
                  <span className={s.id === current?.id ? 'font-medium text-accent' : 'text-muted'}>
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

      {entries.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Ledger</h2>
          <ul className="th-card divide-y divide-border">
            {entries.map((e) => (
              <li key={e.id} className="flex flex-wrap justify-between gap-2 px-4 py-2 text-sm">
                <span>
                  {formatLeaveDate(e.effectiveDate)}{' '}
                  <span className="text-muted">
                    {e.leaveType.name} earned
                    {e.expiresOn ? ` · usable until ${formatLeaveDate(e.expiresOn)}` : ''}
                    {e.note ? ` · ${e.note}` : ''}
                  </span>
                </span>
                <span className="tabular-nums">+{show(e.minutes)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {log.status === 'APPROVED' && log.earnedMinutes === 0 && (
        <p className="text-sm text-muted">
          Approved, but nothing was banked: the benefit year it was worked in had closed, and its
          rollover would not have kept it.
        </p>
      )}

      {canDecide && (
        <section className="space-y-4 border-t border-border pt-6">
          <h2 className="text-lg font-semibold">Your decision</h2>
          <div className="grid gap-6 sm:grid-cols-2">
            <ConfigForm action={approveOvertime} successMessage="Approved.">
              <input type="hidden" name="logId" value={log.id} />
              <Field label="Comment (optional)" name="comment">
                <input id="comment" name="comment" maxLength={500} className="th-input" />
              </Field>
              <SubmitButton label="Approve" pendingLabel="Approving…" />
            </ConfigForm>
            <ConfigForm action={denyOvertime} successMessage="Denied.">
              <input type="hidden" name="logId" value={log.id} />
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

          <ConfigForm action={overrideApproveOvertime} successMessage="Step approved.">
            <input type="hidden" name="logId" value={log.id} />
            <Field label="Reason for approving on their behalf" name="reason">
              <input id="approve-reason" name="reason" required minLength={5} className="th-input" />
            </Field>
            <SubmitButton label="Approve this step" pendingLabel="Approving…" />
          </ConfigForm>

          <ConfigForm action={overrideSkipOvertimeStep} successMessage="Step skipped.">
            <input type="hidden" name="logId" value={log.id} />
            <Field label="Reason for skipping" name="reason">
              <input id="skip-reason" name="reason" required minLength={5} className="th-input" />
            </Field>
            <SubmitButton label="Skip this step" pendingLabel="Skipping…" />
          </ConfigForm>

          <ConfigForm action={rerouteOvertime} successMessage="Rerouted.">
            <input type="hidden" name="logId" value={log.id} />
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
              <input id="reroute-reason" name="reason" required minLength={5} className="th-input" />
            </Field>
            <SubmitButton label="Reroute" pendingLabel="Rerouting…" />
          </ConfigForm>
        </section>
      )}

      {cancellable && (
        <section className="space-y-4 border-t border-border pt-6">
          <div>
            <h2 className="text-lg font-semibold">Cancel</h2>
            <p className="mt-1 text-sm text-muted">
              {log.status === 'APPROVED'
                ? 'The comp time it banked is taken back with an adjustment, even if that takes the balance below zero. The original entry stays in the ledger.'
                : 'Nobody further will be asked to approve it.'}
            </p>
          </div>
          <ConfigForm action={cancelOvertime} successMessage="Cancelled.">
            <input type="hidden" name="logId" value={log.id} />
            {!own && (
              <Field label="Reason for cancelling" name="reason">
                <input id="cancel-reason" name="reason" required minLength={5} className="th-input" />
              </Field>
            )}
            <SubmitButton label="Cancel overtime" pendingLabel="Cancelling…" />
          </ConfigForm>
        </section>
      )}
    </div>
  )
}
