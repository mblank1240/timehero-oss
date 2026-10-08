'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import type { ActionResult } from '@/lib/employees/actions'

type BoundJobAction = (
  previousState?: ActionResult | null,
  formData?: FormData,
) => Promise<ActionResult>

/**
 * Runs one job, optionally for a past date.
 *
 * The date box is not a convenience: GitHub's scheduled triggers can run late
 * or be missed entirely, and every job is written to be re-run for a past day.
 * Without somewhere to type the date, recovering a missed run would mean a
 * database console.
 */
export function JobRunner({ action }: { action: BoundJobAction }) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(
    (previous, formData) => action(previous, formData),
    null,
  )

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <div>
        <label className="th-label" htmlFor="date">
          As of
        </label>
        <input
          type="date"
          name="date"
          className="th-input"
          aria-label="Date to run the job for"
        />
      </div>
      <RunButton />
      {state?.ok && <span className="text-xs text-muted">Done — see the run log below.</span>}
      {state && !state.ok && (
        <span role="alert" className="text-xs text-danger">
          {state.error}
        </span>
      )}
    </form>
  )
}

function RunButton() {
  const { pending } = useFormStatus()
  return (
    <button type="submit" disabled={pending} className="th-btn-secondary">
      {pending ? 'Running…' : 'Run now'}
    </button>
  )
}
