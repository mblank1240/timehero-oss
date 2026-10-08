'use client'

import { useActionState, useEffect, useMemo, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { formatDuration, type DisplayUnit, type IncrementOption } from '@/lib/duration'
import type { ActionResult } from '@/lib/employees/actions'
import {
  amendRequest,
  previewRequest,
  recordLeave,
  submitRequest,
  type RequestPreview,
} from '@/lib/requests/actions'

export type LeaveTypeChoice = { id: string; name: string; balanceMinutes: number }

type Props = {
  leaveTypes: LeaveTypeChoice[]
  /** From `incrementOptions()`, so every choice is valid by construction. */
  options: IncrementOption[]
  /** What a working day defaults to — a full day where the increments allow one. */
  defaultMinutes: number
  minutesPerDay: number
  incrementMinutes: number
  allowSubIncrementWhenBalanceIsLower: boolean
  displayUnit: DisplayUnit
  /** ISO weekdays, 1 = Monday. Days outside it default to no leave. */
  workWeekDays: number[]
  /** ISO date → holiday name. */
  holidays: Record<string, string>
  today: string
  latest: string
  maxDays: number
  /**
   * An administrator recording leave for someone else, or amending a
   * request. Adds the reason and the override choices, and previews against
   * that employee's balance.
   */
  admin?: {
    mode: 'record' | 'amend'
    employeeId: string
    employeeName: string
    requestId?: string
    /** Amending an approved request: it stays approved. */
    approved?: boolean
  }
  /** The request being amended, as it stands. */
  initial?: {
    leaveTypeId: string
    start: string
    end: string
    /** Every date in the range, with 0 for days not taken. */
    minutes: Record<string, number>
    note: string
  }
}

const MS_PER_DAY = 86_400_000

function eachDay(start: string, end: string, max: number): string[] | null {
  const from = Date.parse(`${start}T00:00:00Z`)
  const to = Date.parse(`${end}T00:00:00Z`)
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return []
  const count = (to - from) / MS_PER_DAY + 1
  if (count > max) return null
  return Array.from({ length: count }, (_, i) =>
    new Date(from + i * MS_PER_DAY).toISOString().slice(0, 10),
  )
}

function isoWeekday(iso: string): number {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay()
  return day === 0 ? 7 : day
}

function dayLabel(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

/**
 * Request time off: a date range, then a picker per day.
 *
 * The picker offers only valid increments, generated from the org increment
 * and this employee's working day, so the increment rule is something an
 * employee never sees fail. The one exception is a remainder smaller than an
 * increment, offered as "All remaining" when the projected balance on a
 * single-day request is exactly that — the stranded-balance rule, which the
 * server checks again.
 *
 * The projected balance underneath is advisory. The server runs the same
 * projection inside the submission and is the one that decides.
 */
export function LeaveRequestForm(props: Props) {
  const action = !props.admin
    ? submitRequest
    : props.admin.mode === 'record'
      ? recordLeave
      : amendRequest
  const [state, formAction] = useActionState<ActionResult | null, FormData>(action, null)
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {}

  const [leaveTypeId, setLeaveTypeId] = useState(
    props.initial?.leaveTypeId ?? props.leaveTypes[0]?.id ?? '',
  )
  const [start, setStart] = useState(props.initial?.start ?? '')
  const [end, setEnd] = useState(props.initial?.end ?? '')
  const [chosen, setChosen] = useState<Record<string, number>>(props.initial?.minutes ?? {})
  const [approveNow, setApproveNow] = useState(false)
  // Keyed by the request it was computed for, so a stale answer for a
  // different set of days is never shown while the next one is on its way.
  const [previewed, setPreviewed] = useState<{ key: string; result: RequestPreview } | null>(null)

  const range = useMemo(
    () => (start ? eachDay(start, end || start, props.maxDays) : []),
    [start, end, props.maxDays],
  )

  const defaultFor = (iso: string) => {
    if (props.holidays[iso]) return 0
    return props.workWeekDays.includes(isoWeekday(iso)) ? props.defaultMinutes : 0
  }

  const days = (range ?? []).map((iso) => ({ date: iso, minutes: chosen[iso] ?? defaultFor(iso) }))
  const taken = days.filter((d) => d.minutes > 0)
  const total = taken.reduce((sum, d) => sum + d.minutes, 0)
  const previewKey =
    leaveTypeId && taken.length > 0
      ? JSON.stringify({
          leaveTypeId,
          days: taken,
          employeeId: props.admin?.employeeId,
          requestId: props.admin?.requestId,
        })
      : null
  const preview = previewed && previewed.key === previewKey ? previewed.result : null

  useEffect(() => {
    if (!previewKey) return
    let cancelled = false
    const timer = setTimeout(() => {
      void previewRequest(JSON.parse(previewKey)).then((result) => {
        if (!cancelled) setPreviewed({ key: previewKey, result })
      })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [previewKey])

  const show = (minutes: number) =>
    formatDuration(minutes, { unit: props.displayUnit, minutesPerDay: props.minutesPerDay })

  const remainder =
    props.allowSubIncrementWhenBalanceIsLower &&
    preview?.ok &&
    preview.availableMinutes > 0 &&
    preview.availableMinutes < props.incrementMinutes &&
    taken.length <= 1
      ? preview.availableMinutes
      : null

  if (props.leaveTypes.length === 0) {
    return (
      <p className="text-sm text-muted">
        No leave types are available to {props.admin ? props.admin.employeeName : 'you'} yet.
      </p>
    )
  }

  const mayOverdraw = props.admin && (props.admin.mode === 'amend' || approveNow)

  return (
    <form action={formAction} className="space-y-6">
      {state && !state.ok && (
        <p role="alert" className="th-error">
          {state.error}
        </p>
      )}
      {props.admin && <input type="hidden" name="employeeId" value={props.admin.employeeId} />}
      {props.admin?.requestId && (
        <input type="hidden" name="requestId" value={props.admin.requestId} />
      )}

      <div>
        <label htmlFor="leaveTypeId" className="th-label">
          Leave type
        </label>
        <select
          id="leaveTypeId"
          name="leaveTypeId"
          value={leaveTypeId}
          onChange={(e) => setLeaveTypeId(e.target.value)}
          className="th-input"
        >
          {props.leaveTypes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} — {show(t.balanceMinutes)} available today
            </option>
          ))}
        </select>
        {errors.leaveTypeId?.map((e) => (
          <p key={e} className="th-field-error">
            {e}
          </p>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="start" className="th-label">
            First day
          </label>
          <input
            id="start"
            type="date"
            required
            max={props.latest}
            value={start}
            onChange={(e) => {
              setStart(e.target.value)
              if (!end || e.target.value > end) setEnd(e.target.value)
            }}
            className="th-input"
          />
        </div>
        <div>
          <label htmlFor="end" className="th-label">
            Last day
          </label>
          <input
            id="end"
            type="date"
            required
            min={start || undefined}
            max={props.latest}
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="th-input"
          />
        </div>
      </div>

      {range === null && (
        <p className="th-error">One request can cover at most {props.maxDays} days.</p>
      )}

      {days.length > 0 && (
        <fieldset className="th-card divide-y divide-border">
          <legend className="sr-only">Time off each day</legend>
          {days.map(({ date, minutes }) => {
            const holiday = props.holidays[date]
            const dayErrors = errors[`day.${date}`]
            return (
              <div
                key={date}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-2"
              >
                <label htmlFor={`day.${date}`} className="text-sm">
                  {dayLabel(date)}
                  {holiday && <span className="ml-2 text-xs text-muted">Holiday — {holiday}</span>}
                </label>
                {holiday ? (
                  <span className="text-sm text-muted">No leave needed</span>
                ) : (
                  <select
                    id={`day.${date}`}
                    name={`day.${date}`}
                    value={minutes}
                    onChange={(e) => setChosen({ ...chosen, [date]: Number(e.target.value) })}
                    className="th-input mt-0 w-auto"
                  >
                    <option value={0}>None</option>
                    {props.options.map((o) => (
                      <option key={o.minutes} value={o.minutes}>
                        {o.label}
                      </option>
                    ))}
                    {remainder !== null && !props.options.some((o) => o.minutes === remainder) && (
                      <option value={remainder}>All remaining ({show(remainder)})</option>
                    )}
                  </select>
                )}
                {dayErrors?.map((e) => (
                  <p key={e} className="th-field-error w-full">
                    {e}
                  </p>
                ))}
              </div>
            )
          })}
        </fieldset>
      )}

      {errors.days?.map((e) => (
        <p key={e} className="th-field-error">
          {e}
        </p>
      ))}

      {taken.length > 0 && (
        <section aria-live="polite" className="th-card space-y-1 p-4 text-sm">
          <p>
            <span className="text-muted">Requesting:</span>{' '}
            <span className="font-medium">{show(total)}</span> over {taken.length}{' '}
            {taken.length === 1 ? 'day' : 'days'}
          </p>
          {preview?.ok ? (
            <>
              <p>
                <span className="text-muted">Projected balance on {dayLabel(taken[0].date)}:</span>{' '}
                <span className="font-medium">{show(preview.availableMinutes)}</span>
                {preview.pendingMinutes > 0 && (
                  <span className="text-muted">
                    {' '}
                    (other pending requests hold {show(preview.pendingMinutes)})
                  </span>
                )}
              </p>
              <p>
                <span className="text-muted">After this request:</span>{' '}
                <span className="font-medium">{show(preview.balanceAfterMinutes)}</span>
              </p>
              {preview.shortfall && (
                <p className="text-danger">
                  Not enough time: this would leave {show(preview.shortfall.balanceMinutes)} on{' '}
                  {dayLabel(preview.shortfall.date)}.
                </p>
              )}
              <p className="text-xs text-muted">
                Includes scheduled accruals between now and then.
              </p>
            </>
          ) : (
            <p className="text-muted">Working out the projected balance…</p>
          )}
        </section>
      )}

      <div>
        <label htmlFor="note" className="th-label">
          Note <span className="font-normal text-muted">(optional)</span>
        </label>
        <textarea
          id="note"
          name="note"
          maxLength={500}
          rows={2}
          defaultValue={props.initial?.note}
          className="th-input"
        />
        {errors.note?.map((e) => (
          <p key={e} className="th-field-error">
            {e}
          </p>
        ))}
      </div>

      {props.admin && (
        <fieldset className="th-card space-y-4 p-4">
          <legend className="px-1 text-sm font-semibold">Administrator</legend>
          {props.admin.mode === 'record' && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                name="approveNow"
                checked={approveNow}
                onChange={(e) => setApproveNow(e.target.checked)}
                className="mt-1"
              />
              <span>
                Record it as already approved
                <span className="block text-xs text-muted">
                  For leave already agreed or already taken. Otherwise it goes to{' '}
                  {props.admin.employeeName}&rsquo;s approvers like any request.
                </span>
              </span>
            </label>
          )}
          {mayOverdraw && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="allowOverdraw" className="mt-1" />
              <span>
                Allow it to take the balance below zero
                <span className="block text-xs text-muted">
                  Only if the projection above says there is not enough time.
                </span>
              </span>
            </label>
          )}
          <div>
            <label htmlFor="reason" className="th-label">
              Reason
            </label>
            <textarea
              id="reason"
              name="reason"
              required
              minLength={5}
              maxLength={500}
              rows={2}
              className="th-input"
            />
            {errors.reason?.map((e) => (
              <p key={e} className="th-field-error">
                {e}
              </p>
            ))}
          </div>
        </fieldset>
      )}

      <SubmitButton
        disabled={taken.length === 0}
        label={
          props.admin?.mode === 'record'
            ? 'Record leave'
            : props.admin?.mode === 'amend'
              ? 'Save changes'
              : 'Submit request'
        }
      />
    </form>
  )
}

function SubmitButton({ disabled, label }: { disabled: boolean; label: string }) {
  const { pending } = useFormStatus()
  return (
    <button type="submit" disabled={pending || disabled} className="th-btn">
      {pending ? 'Saving…' : label}
    </button>
  )
}
