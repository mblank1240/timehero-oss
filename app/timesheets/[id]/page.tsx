import Link from 'next/link'
import { notFound } from 'next/navigation'

import { ConfigForm, Field, SubmitButton } from '@/components/form'
import { GridInput, IntentButton } from '@/components/timesheet-fields'
import { TimesheetStatusBadge } from '@/components/timesheet-table'
import { requireUser } from '@/lib/authz'
import { db } from '@/lib/db'
import { formatDuration } from '@/lib/duration'
import { orgSettingsOrThrow } from '@/lib/ledger/policies'
import { currentStep, mayDecide } from '@/lib/requests/chain'
import { STEP_STATUS_LABEL, formatLeaveDate, formatTimestamp } from '@/lib/requests/format'
import {
  approveTimesheet,
  overrideApproveTimesheet,
  overrideSkipTimesheetStep,
  rejectTimesheet,
  rerouteTimesheetAction,
  saveTimesheetGrid,
  unlockTimesheetAction,
  withdrawTimesheetAction,
} from '@/lib/timesheets/actions'
import { firstSubmissions, gridFor, isEditable, sheetHead } from '@/lib/timesheets/data'
import { TIMELINESS_LABEL, timeliness, timesheetDueDate } from '@/lib/timesheets/due'
import { formatPeriod } from '@/lib/timesheets/format'
import { canViewTimesheet, timesheetSteps } from '@/lib/timesheets/queries'
import { noteField, workedField } from '@/lib/timesheets/schema'
import { can } from '@/lib/permissions'

export const metadata = { title: 'Timesheet · TimeHero' }

const shortDate = (date: Date) =>
  date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })

export default async function TimesheetPage({ params }: PageProps<'/timesheets/[id]'>) {
  const { id } = await params
  const user = await requireUser()
  const sheet = await sheetHead(id)
  const steps = sheet ? await timesheetSteps(sheet.id) : []

  // A timesheet someone may not see does not exist, to them (rule 8).
  if (!sheet || !canViewTimesheet(user, sheet, steps)) notFound()

  const [org, grid, record, firsts] = await Promise.all([
    orgSettingsOrThrow(),
    gridFor(sheet),
    db.timesheet.findUniqueOrThrow({
      where: { id: sheet.id },
      select: { submittedAt: true, resolvedAt: true },
    }),
    firstSubmissions([sheet.id]),
  ])
  const dueDate = timesheetDueDate(sheet.payPeriod.endDate, org.timesheetDueDaysAfterPeriodEnd)
  const timing = timeliness({
    dueDate,
    firstSubmittedAt: firsts.get(sheet.id) ?? null,
    now: new Date(),
    timeZone: org.timezone,
  })

  // Worked time is always shown in hours; the day length only matters for
  // the DAYS unit, which a timesheet never uses.
  const minutesPerDay = sheet.employee.standardMinutesPerDay
  const clock = (minutes: number) => formatDuration(minutes, { unit: 'HOURS', minutesPerDay })

  const own = user.id === sheet.employeeId
  const actsForOthers = can(user, 'MANAGE_TIME_RECORDS')
  const reports = can(user, 'REPORT_TIMESHEETS')
  // An administrator may fill in someone else's, with a reason (see saveTimesheet).
  const editable = (own || actsForOthers) && isEditable(sheet.status)
  const current = sheet.status === 'SUBMITTED' ? currentStep(steps) : null
  const canDecide = current !== null && mayDecide(current, user, sheet.employeeId)
  const canOverride = current !== null && actsForOthers && !own && !canDecide
  const canUnlock =
    actsForOthers && !own && (sheet.status === 'APPROVED' || sheet.status === 'SUBMITTED')
  const sentBack =
    sheet.status === 'REJECTED' ? [...steps].reverse().find((s) => s.status === 'DENIED') : null

  const rerouteTargets = canOverride
    ? await db.employee.findMany({
        where: {
          isActive: true,
          id: { notIn: [sheet.employeeId, ...(current?.approverId ? [current.approverId] : [])] },
        },
        select: { id: true, firstName: true, lastName: true },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      })
    : []

  const days = (
    <ol className="th-card divide-y divide-border">
      {grid.days.map((day) => (
        <li
          key={day.iso}
          className={`grid items-start gap-2 px-4 py-3 text-sm sm:grid-cols-[8rem_7rem_1fr_6rem] ${day.employed ? '' : 'text-muted'}`}
        >
          <div>
            <p className="font-medium">{shortDate(day.date)}</p>
            {day.holiday && (
              <p className="text-xs text-muted">
                {day.holiday.name} · {clock(day.holiday.minutes)}
              </p>
            )}
            {day.leave.map((l) => (
              <p key={l.leaveRequestId} className="text-xs text-muted">
                <Link href={`/requests/${l.leaveRequestId}`} className="hover:text-foreground">
                  {l.leaveTypeName} · {clock(l.minutes)}
                </Link>
              </p>
            ))}
            {!day.employed && <p className="text-xs">Not employed</p>}
          </div>

          {editable && day.employed ? (
            <>
              <GridInput
                name={workedField(day.iso)}
                label={`Time worked on ${shortDate(day.date)}`}
                defaultValue={day.worked > 0 ? clock(day.worked) : ''}
                placeholder="0"
              />
              <GridInput
                name={noteField(day.iso)}
                label={`Note for ${shortDate(day.date)}`}
                defaultValue={day.note ?? ''}
                placeholder="Note (optional)"
                maxLength={200}
              />
            </>
          ) : (
            <>
              <p className="tabular-nums">{day.worked > 0 ? clock(day.worked) : '—'}</p>
              <p className="text-muted">{day.note}</p>
            </>
          )}

          <p className="text-xs tabular-nums sm:pt-2 sm:text-right">
            {day.overtime > 0 && (
              <span className="font-medium text-accent">{clock(day.overtime)} overtime</span>
            )}
          </p>
        </li>
      ))}
    </ol>
  )

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div className="space-y-2">
        <p className="text-sm">
          <Link
            href={own ? '/timesheets' : reports ? '/reports/timesheets' : '/approvals'}
            className="text-muted hover:text-foreground"
          >
            ← {own ? 'Timesheets' : reports ? 'All timesheets' : 'Approvals'}
          </Link>
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">
            Timesheet
            {!own && (
              <span className="font-normal text-muted">
                {' '}
                for {sheet.employee.firstName} {sheet.employee.lastName}
              </span>
            )}
          </h1>
          <TimesheetStatusBadge status={sheet.status} />
        </div>
        <p className="text-sm">
          {formatPeriod(sheet.payPeriod)} · due {formatLeaveDate(dueDate)}
          {(timing === 'LATE' || timing === 'OVERDUE') && (
            <span className="font-medium text-danger"> · {TIMELINESS_LABEL[timing]}</span>
          )}{' '}
          · paid {formatLeaveDate(sheet.payPeriod.payDate)}
        </p>
        {reports && (
          <p className="text-sm">
            <a href={`/reports/timesheets/export?timesheet=${sheet.id}`} className="underline" download>
              Download CSV
            </a>
          </p>
        )}
        {record.submittedAt && (
          <p className="text-xs text-muted">
            Submitted {formatTimestamp(record.submittedAt, org.timezone)}
            {record.resolvedAt &&
              ` · ${sheet.status === 'APPROVED' ? 'approved' : 'sent back'} ${formatTimestamp(record.resolvedAt, org.timezone)}`}
          </p>
        )}
      </div>

      {sentBack && (
        <p role="status" className="th-card border-danger/40 p-3 text-sm">
          Sent back by{' '}
          {sentBack.decidedBy
            ? `${sentBack.decidedBy.firstName} ${sentBack.decidedBy.lastName}`
            : 'an approver'}
          {sentBack.comment ? `: “${sentBack.comment}”` : '.'} Correct it and submit it again.
        </p>
      )}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Summary</h2>
        <dl className="th-card grid grid-cols-2 gap-4 p-4 text-sm sm:grid-cols-5">
          <Total label="Worked" value={clock(grid.totals.worked)} />
          <Total label="Regular" value={clock(grid.totals.regular)} />
          <Total label="Overtime" value={clock(grid.totals.overtime)} />
          <Total label="Holiday" value={clock(grid.totals.holiday)} />
          <Total label="Leave" value={clock(grid.totals.leave)} />
        </dl>
        {grid.totals.leaveByType.length > 1 && (
          <p className="text-xs text-muted">
            {grid.totals.leaveByType.map((t) => `${t.leaveTypeName} ${clock(t.minutes)}`).join(' · ')}
          </p>
        )}
        <p className="text-xs text-muted">
          Overtime is time worked beyond {clock(org.overtimeWeeklyThresholdMinutes)} in a workweek,
          counted from the day the threshold is passed. Leave and holidays do not count toward it.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Days</h2>
        {editable ? (
          <ConfigForm action={saveTimesheetGrid} successMessage="Saved." className="space-y-4">
            <input type="hidden" name="timesheetId" value={sheet.id} />
            <p className="text-sm text-muted">
              Enter time as 7h 30m, 7:30 or 7.5, in steps of {org.timesheetIncrementMinutes}{' '}
              minutes. Leave and holidays are filled in from the calendar and cannot be changed here.
            </p>
            {days}
            {!own && (
              <Field label="Reason for changing this timesheet" name="reason">
                <input id="ts-reason" name="reason" required minLength={5} className="th-input" />
              </Field>
            )}
            <div className="flex flex-wrap gap-3">
              <IntentButton intent="save" label="Save" pendingLabel="Saving…" />
              <IntentButton
                intent="submit"
                label="Save and submit"
                pendingLabel="Submitting…"
                primary
              />
            </div>
          </ConfigForm>
        ) : (
          days
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Workweeks</h2>
        <ul className="th-card divide-y divide-border">
          {grid.weeks.map((w) => (
            <li key={w.start.toISOString()} className="flex flex-wrap justify-between gap-2 px-4 py-2 text-sm">
              <span>
                {shortDate(w.start)} – {shortDate(w.end)}
                {w.weekWorked !== w.worked && (
                  <span className="text-xs text-muted">
                    {' '}
                    · {clock(w.weekWorked)} across both pay periods
                  </span>
                )}
              </span>
              <span className="tabular-nums">
                {clock(w.worked)} worked
                {w.overtime > 0 && <span className="text-accent"> · {clock(w.overtime)} overtime</span>}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {steps.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Approval</h2>
          <ol className="th-card divide-y divide-border">
            {steps.map((s) => {
              const who = s.approver
                ? `${s.approver.firstName} ${s.approver.lastName}`
                : 'Any administrator'
              const by =
                s.decidedBy && s.decidedBy.id !== s.approverId
                  ? ` by ${s.decidedBy.firstName} ${s.decidedBy.lastName}`
                  : ''
              const label = s.status === 'DENIED' ? 'Sent back' : STEP_STATUS_LABEL[s.status]
              return (
                <li key={s.id} className="space-y-0.5 px-4 py-2 text-sm">
                  <div className="flex flex-wrap justify-between gap-2">
                    <span>
                      <span className="text-muted">Step {s.step}:</span> {who}
                    </span>
                    <span className={s.id === current?.id ? 'font-medium text-accent' : 'text-muted'}>
                      {s.id === current?.id ? 'Waiting' : label}
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

      {own && sheet.status === 'SUBMITTED' && (
        <section className="space-y-4 border-t border-border pt-6">
          <div>
            <h2 className="text-lg font-semibold">Withdraw</h2>
            <p className="mt-1 text-sm text-muted">
              Takes it back so you can make changes. You will need to submit it again.
            </p>
          </div>
          <ConfigForm action={withdrawTimesheetAction}>
            <input type="hidden" name="timesheetId" value={sheet.id} />
            <SubmitButton label="Withdraw timesheet" pendingLabel="Withdrawing…" />
          </ConfigForm>
        </section>
      )}

      {canDecide && (
        <section className="space-y-4 border-t border-border pt-6">
          <h2 className="text-lg font-semibold">Your decision</h2>
          <div className="grid gap-6 sm:grid-cols-2">
            <ConfigForm action={approveTimesheet} successMessage="Approved.">
              <input type="hidden" name="timesheetId" value={sheet.id} />
              <Field label="Comment (optional)" name="comment">
                <input id="comment" name="comment" maxLength={500} className="th-input" />
              </Field>
              <SubmitButton label="Approve" pendingLabel="Approving…" />
            </ConfigForm>
            <ConfigForm action={rejectTimesheet} successMessage="Sent back.">
              <input type="hidden" name="timesheetId" value={sheet.id} />
              <Field label="What needs correcting" name="comment" id="reject-comment">
                <input id="reject-comment" name="comment" maxLength={500} className="th-input" />
              </Field>
              <SubmitButton label="Send back" pendingLabel="Sending back…" />
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

          <ConfigForm action={overrideApproveTimesheet} successMessage="Step approved.">
            <input type="hidden" name="timesheetId" value={sheet.id} />
            <Field label="Reason for approving on their behalf" name="reason" id="approve-reason">
              <input id="approve-reason" name="reason" required minLength={5} className="th-input" />
            </Field>
            <SubmitButton label="Approve this step" pendingLabel="Approving…" />
          </ConfigForm>

          <ConfigForm action={overrideSkipTimesheetStep} successMessage="Step skipped.">
            <input type="hidden" name="timesheetId" value={sheet.id} />
            <Field label="Reason for skipping" name="reason" id="skip-reason">
              <input id="skip-reason" name="reason" required minLength={5} className="th-input" />
            </Field>
            <SubmitButton label="Skip this step" pendingLabel="Skipping…" />
          </ConfigForm>

          <ConfigForm action={rerouteTimesheetAction} successMessage="Rerouted.">
            <input type="hidden" name="timesheetId" value={sheet.id} />
            <Field label="Send this step to" name="approverId">
              <select id="approverId" name="approverId" required className="th-input">
                {rerouteTargets.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.lastName}, {e.firstName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Reason for rerouting" name="reason" id="reroute-reason">
              <input id="reroute-reason" name="reason" required minLength={5} className="th-input" />
            </Field>
            <SubmitButton label="Reroute" pendingLabel="Rerouting…" />
          </ConfigForm>
        </section>
      )}

      {canUnlock && (
        <section className="space-y-4 border-t border-border pt-6">
          <div>
            <h2 className="text-lg font-semibold">Unlock</h2>
            <p className="mt-1 text-sm text-muted">
              Reopens the timesheet so {sheet.employee.firstName} can change it. It goes through
              approval again when they resubmit. The reason is kept in the audit log.
            </p>
          </div>
          <ConfigForm action={unlockTimesheetAction} successMessage="Unlocked.">
            <input type="hidden" name="timesheetId" value={sheet.id} />
            <Field label="Reason for unlocking" name="reason" id="unlock-reason">
              <input id="unlock-reason" name="reason" required minLength={5} className="th-input" />
            </Field>
            <SubmitButton label="Unlock timesheet" pendingLabel="Unlocking…" />
          </ConfigForm>
        </section>
      )}
    </div>
  )
}

function Total({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-base font-medium tabular-nums">{value}</dd>
    </div>
  )
}
