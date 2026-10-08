'use client'

import { createContext, useActionState, useContext, useState } from 'react'
import { useFormStatus } from 'react-dom'

import type { ActionResult } from '@/lib/employees/actions'

type FormAction = (
  previousState: ActionResult | null,
  formData: FormData,
) => Promise<ActionResult>

const FieldErrorContext = createContext<Record<string, string[]>>({})

/**
 * Wraps a server action with `useActionState` and publishes its field errors
 * to any `<Field>` below. The `action` prop goes on the form element rather
 * than an onSubmit handler, so the browser submits natively if hydration
 * hasn't finished.
 */
export function ConfigForm({
  action,
  children,
  successMessage,
  className = 'space-y-5',
}: {
  action: FormAction
  children: React.ReactNode
  successMessage?: string
  className?: string
}) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(action, null)
  const fieldErrors = state && !state.ok ? (state.fieldErrors ?? {}) : {}

  return (
    <FieldErrorContext.Provider value={fieldErrors}>
      <form action={formAction} className={className}>
        {state && !state.ok && (
          <p role="alert" className="th-error">
            {state.error}
          </p>
        )}
        {state?.ok && successMessage && (
          <p className="text-sm text-muted">{successMessage}</p>
        )}
        {children}
      </form>
    </FieldErrorContext.Provider>
  )
}

/** The errors the enclosing `ConfigForm`'s last submission returned for `name`. */
export function useFieldErrors(name: string): string[] | undefined {
  return useContext(FieldErrorContext)[name]
}

export function Field({
  label,
  name,
  id,
  hint,
  children,
}: {
  label: string
  name: string
  /** The control's id, when it is not `name` — two forms on a page can share a field name. */
  id?: string
  hint?: string
  children: React.ReactNode
}) {
  const errors = useFieldErrors(name)

  return (
    <div>
      <label htmlFor={id ?? name} className="th-label">
        {label}
      </label>
      {children}
      {hint && !errors?.length && <p className="mt-1 text-xs text-muted">{hint}</p>}
      {errors?.map((e) => (
        <p key={e} className="th-field-error">
          {e}
        </p>
      ))}
    </div>
  )
}

export function Checkbox({
  name,
  label,
  defaultChecked,
  hint,
}: {
  name: string
  label: string
  defaultChecked?: boolean
  hint?: string
}) {
  return (
    <div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name={name}
          value="true"
          defaultChecked={defaultChecked}
          className="mt-0.5 h-4 w-4 rounded border-border"
        />
        <span>{label}</span>
      </label>
      {hint && <p className="ml-6 mt-1 text-xs text-muted">{hint}</p>}
    </div>
  )
}

export function SubmitButton({
  label,
  pendingLabel = 'Saving…',
}: {
  label: string
  pendingLabel?: string
}) {
  const { pending } = useFormStatus()
  return (
    <button type="submit" disabled={pending} className="th-btn">
      {pending ? pendingLabel : label}
    </button>
  )
}

/**
 * A button that calls a server action taking a single id — delete, sync and
 * similar. Rendered as its own form so it never nests inside another.
 *
 * Destructive actions confirm inline rather than through `window.confirm`.
 * The native dialog has to be cancelled from the form's `onSubmit`, and
 * calling `preventDefault` there also cancels React's action — so a mistimed
 * or suppressed dialog silently swallows the click. An inline step is
 * ordinary DOM: visible, keyboard-reachable and testable.
 */
export function ActionButton({
  action,
  label,
  pendingLabel = 'Working…',
  confirmLabel,
  variant = 'secondary',
}: {
  // A server action already bound to its id. Passed to useActionState
  // unwrapped so React can progressively enhance the form — wrapping it in a
  // client closure would leave the button dead until hydration finishes.
  action: (
    previousState?: ActionResult | null,
    formData?: FormData,
  ) => Promise<ActionResult>
  label: string
  pendingLabel?: string
  /** When set, the first click arms the button and a second one runs it. */
  confirmLabel?: string
  variant?: 'primary' | 'secondary' | 'danger'
}) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(action, null)
  const [armed, setArmed] = useState(false)

  const className =
    variant === 'primary'
      ? 'th-btn'
      : variant === 'danger'
        ? 'th-btn-secondary text-danger'
        : 'th-btn-secondary'

  if (confirmLabel && !armed) {
    return (
      <button type="button" onClick={() => setArmed(true)} className={className}>
        {label}
      </button>
    )
  }

  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      <PendingButton
        label={confirmLabel ?? label}
        pendingLabel={pendingLabel}
        className={className}
      />
      {confirmLabel && (
        <button
          type="button"
          onClick={() => setArmed(false)}
          className="text-xs text-muted hover:text-foreground"
        >
          Cancel
        </button>
      )}
      {state && !state.ok && (
        <span role="alert" className="text-xs text-danger">
          {state.error}
        </span>
      )}
    </form>
  )
}

function PendingButton({
  label,
  pendingLabel,
  className,
}: {
  label: string
  pendingLabel: string
  className: string
}) {
  const { pending } = useFormStatus()
  return (
    <button type="submit" disabled={pending} className={className}>
      {pending ? pendingLabel : label}
    </button>
  )
}
