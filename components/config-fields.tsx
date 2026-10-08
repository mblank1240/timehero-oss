/**
 * The fields of the configuration forms, shared by each "add" form and its
 * "edit" page so the two can never drift apart. With no `defaults` they show
 * what a new record starts as; with `defaults` they show the record being
 * edited.
 */

import { Checkbox, Field } from '@/components/form'

export const ACCRUABLE_LABELS: Record<string, string> = {
  ALL: 'All employees',
  HOURLY_ONLY: 'Hourly only',
  EXEMPT_ONLY: 'Salaried (exempt) only',
}

export const METHOD_LABELS: Record<string, string> = {
  ANNUAL_LUMP: 'Whole allotment at once',
  PER_PAY_PERIOD: 'Spread across pay periods',
}

export const FIRST_YEAR_LABELS: Record<string, string> = {
  FULL_AFTER_WAITING: 'Full allotment once the waiting period ends',
  PRORATE: 'Prorated for the remainder of the year',
  NONE: 'Nothing until the next benefit year',
}

export const PAY_SCHEDULE_TYPE_LABELS: Record<string, string> = {
  WEEKLY: 'Weekly',
  BIWEEKLY: 'Every two weeks',
  SEMI_MONTHLY: 'Twice monthly (1st and 16th)',
  MONTHLY: 'Monthly',
}

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export const CAP_LABELS: Record<string, string> = {
  NONE: 'Nothing carries over',
  UNLIMITED: 'Everything carries over',
  FIXED_MINUTES: 'Up to a fixed number of minutes',
  EMPLOYEE_DAYS: "Up to a number of the employee's own days",
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10)

export function LeaveTypeFields({
  defaults,
}: {
  defaults?: {
    name: string
    code: string
    accruableBy: string
    colorHex: string
    sortOrder: number
    isPaid: boolean
    requiresApproval: boolean
    countsTowardRollover: boolean
    allowsNegativeBalance: boolean
    isActive: boolean
  }
}) {
  return (
    <>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Name" name="name">
          <input id="name" name="name" required defaultValue={defaults?.name} className="th-input" />
        </Field>
        <Field
          label="Code"
          name="code"
          hint="Short, stable identifier used in reports, e.g. BEREAVEMENT."
        >
          <input id="code" name="code" required defaultValue={defaults?.code} className="th-input" />
        </Field>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="Who may accrue it"
          name="accruableBy"
          hint="Comp time must be exempt-only: FLSA bars comp time in lieu of overtime pay for non-exempt staff."
        >
          <select
            id="accruableBy"
            name="accruableBy"
            defaultValue={defaults?.accruableBy ?? 'ALL'}
            className="th-input"
          >
            {Object.entries(ACCRUABLE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Colour" name="colorHex" hint="Used in the history heatmap.">
          <input
            id="colorHex"
            name="colorHex"
            type="color"
            defaultValue={defaults?.colorHex ?? '#1d4ed8'}
            className="th-input h-10"
          />
        </Field>
      </div>

      <Field label="Sort order" name="sortOrder">
        <input
          id="sortOrder"
          name="sortOrder"
          type="number"
          min={0}
          max={999}
          defaultValue={defaults?.sortOrder ?? 0}
          required
          className="th-input"
        />
      </Field>

      <div className="space-y-3 rounded-lg border border-border p-4">
        <Checkbox name="isPaid" label="Paid" defaultChecked={defaults?.isPaid ?? true} />
        <Checkbox
          name="requiresApproval"
          label="Requires approval"
          defaultChecked={defaults?.requiresApproval ?? true}
        />
        <Checkbox
          name="countsTowardRollover"
          label="Carries over at the benefit-year boundary"
          defaultChecked={defaults?.countsTowardRollover ?? true}
          hint="Unchecked means the balance is forfeited each year unless a carryover window rescues it."
        />
        <Checkbox
          name="allowsNegativeBalance"
          label="May go negative"
          defaultChecked={defaults?.allowsNegativeBalance ?? false}
          hint="Lets an employee borrow against future accrual. Off for most types."
        />
        <Checkbox name="isActive" label="Active" defaultChecked={defaults?.isActive ?? true} />
      </div>
    </>
  )
}

export function LeavePolicyFields({
  types,
  defaults,
}: {
  types: { id: string; name: string }[]
  defaults?: {
    leaveTypeId: string
    name: string
    annualMinutes: number
    method: string
    waitingPeriodDays: number
    maxBalanceMinutes: number | null
    firstYearGrant: string
    isActive: boolean
  }
}) {
  return (
    <>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Leave type" name="leaveTypeId">
          <select
            id="leaveTypeId"
            name="leaveTypeId"
            required
            defaultValue={defaults?.leaveTypeId}
            className="th-input"
          >
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Policy name" name="name" hint="Distinguishes tiers, e.g. Standard or 10+ Years.">
          <input id="name" name="name" required defaultValue={defaults?.name} className="th-input" />
        </Field>
      </div>

      <Field
        label="Annual allotment (minutes)"
        name="annualMinutes"
        hint="7200 = 120 hours = 15 standard days."
      >
        <input
          id="annualMinutes"
          name="annualMinutes"
          type="number"
          min={0}
          required
          defaultValue={defaults?.annualMinutes ?? 7200}
          className="th-input"
        />
      </Field>

      <Field label="How it accrues" name="method">
        <select
          id="method"
          name="method"
          defaultValue={defaults?.method ?? 'ANNUAL_LUMP'}
          className="th-input"
        >
          {Object.entries(METHOD_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="Waiting period (days)"
          name="waitingPeriodDays"
          hint="The grant lands on the later of the benefit-year start and hire date plus this."
        >
          <input
            id="waitingPeriodDays"
            name="waitingPeriodDays"
            type="number"
            min={0}
            max={730}
            required
            defaultValue={defaults?.waitingPeriodDays ?? 120}
            className="th-input"
          />
        </Field>

        <Field
          label="Balance ceiling (minutes)"
          name="maxBalanceMinutes"
          hint="Blank for none. Accrual pauses while the balance sits at or above this."
        >
          <input
            id="maxBalanceMinutes"
            name="maxBalanceMinutes"
            type="number"
            min={0}
            defaultValue={defaults?.maxBalanceMinutes ?? undefined}
            className="th-input"
          />
        </Field>
      </div>

      <Field label="What a new hire receives" name="firstYearGrant">
        <select
          id="firstYearGrant"
          name="firstYearGrant"
          defaultValue={defaults?.firstYearGrant ?? 'FULL_AFTER_WAITING'}
          className="th-input"
        >
          {Object.entries(FIRST_YEAR_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>

      <Checkbox name="isActive" label="Active" defaultChecked={defaults?.isActive ?? true} />
    </>
  )
}

export function PayScheduleFields({
  defaults,
}: {
  defaults?: {
    name: string
    type: string
    anchorDate: Date
    payDateOffsetDays: number
    isDefault: boolean
    isActive: boolean
  }
}) {
  return (
    <>
      <Field label="Name" name="name">
        <input id="name" name="name" required defaultValue={defaults?.name} className="th-input" />
      </Field>

      <Field label="Frequency" name="type">
        <select
          id="type"
          name="type"
          defaultValue={defaults?.type ?? 'BIWEEKLY'}
          className="th-input"
        >
          {Object.entries(PAY_SCHEDULE_TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Anchor date"
        name="anchorDate"
        hint="The first period's start date. Every period is generated from here, so use a real past period start."
      >
        <input
          id="anchorDate"
          name="anchorDate"
          type="date"
          required
          defaultValue={defaults ? isoDate(defaults.anchorDate) : undefined}
          className="th-input"
        />
      </Field>

      <Field
        label="Pay date offset (days)"
        name="payDateOffsetDays"
        hint="Days after a period ends that payment lands."
      >
        <input
          id="payDateOffsetDays"
          name="payDateOffsetDays"
          type="number"
          min={0}
          max={60}
          required
          defaultValue={defaults?.payDateOffsetDays ?? 5}
          className="th-input"
        />
      </Field>

      <Checkbox
        name="isDefault"
        label="Default schedule for new employees"
        defaultChecked={defaults?.isDefault ?? false}
        hint="Only one schedule can be the default."
      />
      <Checkbox name="isActive" label="Active" defaultChecked={defaults?.isActive ?? true} />
    </>
  )
}

export function CarryoverWindowFields({
  leaveTypeId,
  defaults,
}: {
  leaveTypeId: string
  defaults?: {
    name: string
    earnedFromMonth: number
    earnedFromDay: number
    earnedToMonth: number
    earnedToDay: number
    usableUntilMonth: number
    usableUntilDay: number
    usableUntilYearOffset: number
    capBasis: string
    capValue: number
    isActive: boolean
  }
}) {
  const monthSelect = (id: string, value: number) => (
    <select id={id} name={id} defaultValue={value} className="th-input">
      {MONTHS.map((m, i) => (
        <option key={m} value={i + 1}>
          {m}
        </option>
      ))}
    </select>
  )
  const dayInput = (id: string, value: number, max = 31) => (
    <input
      id={id}
      name={id}
      type="number"
      min={id === 'usableUntilYearOffset' ? 0 : 1}
      max={max}
      defaultValue={value}
      required
      className="th-input"
    />
  )

  return (
    <>
      <input type="hidden" name="leaveTypeId" value={leaveTypeId} />

      <Field label="Name" name="name">
        <input
          id="name"
          name="name"
          required
          defaultValue={defaults?.name}
          placeholder="December comp grace period"
          className="th-input"
        />
      </Field>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          Earned between
        </legend>
        <Field label="From month" name="earnedFromMonth">
          {monthSelect('earnedFromMonth', defaults?.earnedFromMonth ?? 12)}
        </Field>
        <Field label="From day" name="earnedFromDay">
          {dayInput('earnedFromDay', defaults?.earnedFromDay ?? 1)}
        </Field>
        <Field label="To month" name="earnedToMonth">
          {monthSelect('earnedToMonth', defaults?.earnedToMonth ?? 12)}
        </Field>
        <Field label="To day" name="earnedToDay">
          {dayInput('earnedToDay', defaults?.earnedToDay ?? 31)}
        </Field>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-3">
        <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          Usable until
        </legend>
        <Field label="Month" name="usableUntilMonth">
          {monthSelect('usableUntilMonth', defaults?.usableUntilMonth ?? 2)}
        </Field>
        <Field label="Day" name="usableUntilDay">
          {dayInput('usableUntilDay', defaults?.usableUntilDay ?? 28)}
        </Field>
        <Field label="Years later" name="usableUntilYearOffset">
          {dayInput('usableUntilYearOffset', defaults?.usableUntilYearOffset ?? 1, 5)}
        </Field>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Cap" name="capBasis">
          <select
            id="capBasis"
            name="capBasis"
            defaultValue={defaults?.capBasis ?? 'UNLIMITED'}
            className="th-input"
          >
            {Object.entries(CAP_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Cap value" name="capValue">
          <input
            id="capValue"
            name="capValue"
            type="number"
            min={0}
            defaultValue={defaults?.capValue ?? 0}
            required
            className="th-input"
          />
        </Field>
      </div>

      <Checkbox name="isActive" label="Active" defaultChecked={defaults?.isActive ?? true} />
    </>
  )
}
