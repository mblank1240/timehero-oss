'use client'

import Link from 'next/link'
import { useActionState, useRef } from 'react'
import { useFormStatus } from 'react-dom'

import type { ActionResult, FormAction } from '@/lib/employees/actions'

export type EmployeeFormValues = {
  email: string
  firstName: string
  lastName: string
  accessRoleId: string
  employmentType: 'HOURLY' | 'SALARIED_EXEMPT'
  hireDate: string
  terminationDate: string
  departmentId: string
  payScheduleId: string
  employeeTypeId: string
  standardMinutesPerDay: number
  isActive: boolean
}

type Props = {
  action: FormAction
  departments: { id: string; name: string }[]
  paySchedules?: { id: string; name: string }[]
  employeeTypes?: { id: string; name: string; employmentType: 'HOURLY' | 'SALARIED_EXEMPT' }[]
  /**
   * The roles to choose from, for someone who may manage access. Without it
   * the field is shown read-only and not posted, so the record keeps its role.
   */
  accessRoles?: { id: string; name: string }[]
  /** The current role's name, shown when it cannot be changed here. */
  accessRoleName?: string | null
  /**
   * On a new employee, choosing a type fills in its employment type and the
   * type's leave policies are assigned on save. On an existing one the type is
   * a label only, and choosing it changes nothing else.
   */
  isNew?: boolean
  defaults?: Partial<EmployeeFormValues>
  submitLabel: string
}

export function EmployeeForm({
  action,
  departments,
  paySchedules = [],
  employeeTypes = [],
  accessRoles,
  accessRoleName = null,
  isNew = false,
  defaults,
  submitLabel,
}: Props) {
  const employmentTypeRef = useRef<HTMLSelectElement>(null)
  // `action` on the form element rather than an onSubmit handler: the browser
  // posts it natively if hydration hasn't finished, so the form works from
  // the moment the HTML arrives.
  const [state, formAction] = useActionState<ActionResult | null, FormData>(action, null)
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {}

  return (
    <form action={formAction} className="space-y-5">
      {state && !state.ok && (
        <p role="alert" className="th-error">
          {state.error}
        </p>
      )}

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="First name" name="firstName" errors={errors.firstName}>
          <input
            id="firstName"
            name="firstName"
            required
            defaultValue={defaults?.firstName}
            className="th-input"
          />
        </Field>

        <Field label="Last name" name="lastName" errors={errors.lastName}>
          <input
            id="lastName"
            name="lastName"
            required
            defaultValue={defaults?.lastName}
            className="th-input"
          />
        </Field>
      </div>

      <Field
        label="Email"
        name="email"
        errors={errors.email}
        hint="Must match the employee's Microsoft 365 address."
      >
        <input
          id="email"
          name="email"
          type="email"
          required
          defaultValue={defaults?.email}
          className="th-input"
        />
      </Field>

      <Field
        label="Employee type"
        name="employeeTypeId"
        errors={errors.employeeTypeId}
        hint={
          isNew
            ? "Fills in the employment type, and puts them on the type's leave policies from their hire date."
            : 'A label only. Changing it does not change their leave policies — those are managed below.'
        }
      >
        <select
          id="employeeTypeId"
          name="employeeTypeId"
          defaultValue={defaults?.employeeTypeId ?? ''}
          onChange={(event) => {
            // A pre-fill, not a binding: the administrator may still change
            // the employment type, and the one saved is what counts.
            if (!isNew || !employmentTypeRef.current) return
            const chosen = employeeTypes.find((t) => t.id === event.target.value)
            if (chosen) employmentTypeRef.current.value = chosen.employmentType
          }}
          className="th-input"
        >
          <option value="">— None —</option>
          {employeeTypes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        {accessRoles ? (
          <Field label="Access" name="accessRoleId" errors={errors.accessRoleId}>
            <select
              id="accessRoleId"
              name="accessRoleId"
              defaultValue={defaults?.accessRoleId ?? ''}
              className="th-input"
            >
              <option value="">Employee (their own records only)</option>
              {accessRoles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <div>
            <p className="th-label">Access</p>
            <p className="py-2 text-sm">{accessRoleName ?? 'Employee'}</p>
            <p className="text-xs text-muted">Changed by someone who manages access.</p>
          </div>
        )}

        <Field
          label="Employment type"
          name="employmentType"
          errors={errors.employmentType}
          hint="Only salaried (exempt) staff may accrue comp time."
        >
          <select
            ref={employmentTypeRef}
            id="employmentType"
            name="employmentType"
            defaultValue={defaults?.employmentType ?? 'HOURLY'}
            className="th-input"
          >
            <option value="HOURLY">Hourly</option>
            <option value="SALARIED_EXEMPT">Salaried (exempt)</option>
          </select>
        </Field>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Hire date" name="hireDate" errors={errors.hireDate}>
          <input
            id="hireDate"
            name="hireDate"
            type="date"
            required
            defaultValue={defaults?.hireDate}
            className="th-input"
          />
        </Field>

        <Field
          label="Termination date"
          name="terminationDate"
          errors={errors.terminationDate}
          hint="Leave blank for current staff."
        >
          <input
            id="terminationDate"
            name="terminationDate"
            type="date"
            defaultValue={defaults?.terminationDate}
            className="th-input"
          />
        </Field>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Department" name="departmentId" errors={errors.departmentId}>
          <select
            id="departmentId"
            name="departmentId"
            defaultValue={defaults?.departmentId ?? ''}
            className="th-input"
          >
            <option value="">— None —</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Pay schedule"
          name="payScheduleId"
          errors={errors.payScheduleId}
          hint="Per-period accrual and hourly timesheets follow it."
        >
          <select
            id="payScheduleId"
            name="payScheduleId"
            defaultValue={defaults?.payScheduleId ?? ''}
            className="th-input"
          >
            <option value="">— None —</option>
            {paySchedules.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Standard day (minutes)"
          name="standardMinutesPerDay"
          errors={errors.standardMinutesPerDay}
          hint="480 = 8 hours. Sets what a half-day request means for this person."
        >
          <input
            id="standardMinutesPerDay"
            name="standardMinutesPerDay"
            type="number"
            min={1}
            max={1440}
            required
            defaultValue={defaults?.standardMinutesPerDay ?? 480}
            className="th-input"
          />
        </Field>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="isActive"
          value="true"
          defaultChecked={defaults?.isActive ?? true}
          className="h-4 w-4 rounded border-border"
        />
        Active — inactive employees cannot sign in
      </label>

      <div className="flex gap-3">
        <SubmitButton label={submitLabel} />
        <Link href="/admin/employees" className="th-btn-secondary">
          Cancel
        </Link>
      </div>
    </form>
  )
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return (
    <button type="submit" disabled={pending} className="th-btn">
      {pending ? 'Saving…' : label}
    </button>
  )
}

function Field({
  label,
  name,
  hint,
  errors,
  children,
}: {
  label: string
  name: string
  hint?: string
  errors?: string[]
  children: React.ReactNode
}) {
  return (
    <div>
      <label htmlFor={name} className="th-label">
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
