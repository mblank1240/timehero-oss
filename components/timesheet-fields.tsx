'use client'

import { useFormStatus } from 'react-dom'

import { useFieldErrors } from '@/components/form'

/**
 * One cell of the timesheet grid: an input whose label is read aloud but not
 * shown — the row's date already says which day it is — with its errors
 * beneath it.
 */
export function GridInput({
  name,
  label,
  defaultValue,
  placeholder,
  maxLength,
  className = '',
}: {
  name: string
  label: string
  defaultValue: string
  placeholder?: string
  maxLength?: number
  className?: string
}) {
  const errors = useFieldErrors(name)
  return (
    <div className={className}>
      <label htmlFor={name} className="sr-only">
        {label}
      </label>
      <input
        id={name}
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        maxLength={maxLength}
        aria-invalid={errors?.length ? true : undefined}
        className="th-input"
      />
      {errors?.map((e) => (
        <p key={e} className="th-field-error">
          {e}
        </p>
      ))}
    </div>
  )
}

/** A submit button that says which of the form's actions it is. */
export function IntentButton({
  intent,
  label,
  pendingLabel,
  primary = false,
}: {
  intent: string
  label: string
  pendingLabel: string
  primary?: boolean
}) {
  const { pending, data } = useFormStatus()
  const mine = pending && data?.get('intent') === intent
  return (
    <button
      type="submit"
      name="intent"
      value={intent}
      disabled={pending}
      className={primary ? 'th-btn' : 'th-btn-secondary'}
    >
      {mine ? pendingLabel : label}
    </button>
  )
}
