'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { createDepartment, type ActionResult } from '@/lib/employees/actions'

export function DepartmentForm() {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(
    createDepartment,
    null,
  )

  return (
    <form action={formAction} className="space-y-3">
      {state && !state.ok && (
        <p role="alert" className="th-error">
          {state.error}
        </p>
      )}
      {state?.ok && <p className="text-sm text-muted">Department added.</p>}

      <div>
        <label htmlFor="name" className="th-label">
          Name
        </label>
        <input id="name" name="name" required maxLength={100} className="th-input" />
      </div>

      <SubmitButton />
    </form>
  )
}

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button type="submit" disabled={pending} className="th-btn">
      {pending ? 'Adding…' : 'Add department'}
    </button>
  )
}
