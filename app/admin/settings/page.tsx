import { Checkbox, ConfigForm, Field, SubmitButton } from '@/components/form'
import { requireAdmin } from '@/lib/authz'
import { updateOrgSettings } from '@/lib/config/actions'
import { WEEKDAYS } from '@/lib/config/schema'
import { db } from '@/lib/db'

export const metadata = { title: 'Organisation settings · TimeHero' }

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export default async function SettingsPage() {
  await requireAdmin()
  const [settings, compTypes] = await Promise.all([
    db.orgSettings.findUnique({ where: { id: 1 } }),
    // Only types hourly staff cannot hold may receive comp (rule 4).
    db.leaveType.findMany({
      where: { isActive: true, accruableBy: 'EXEMPT_ONLY' },
      select: { id: true, name: true },
      orderBy: { sortOrder: 'asc' },
    }),
  ])

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Organisation settings</h1>
        <p className="mt-1 text-sm text-muted">
          These values drive every accrual and every request. Changing them affects
          future calculations only — nothing already recorded in the ledger moves.
        </p>
      </div>

      <ConfigForm action={updateOrgSettings} successMessage="Settings saved.">
        <Field label="Organisation name" name="name">
          <input
            id="name"
            name="name"
            required
            defaultValue={settings?.name ?? ''}
            className="th-input"
          />
        </Field>

        <Field
          label="Timezone"
          name="timezone"
          hint="Used when rendering dates. Stored dates are timezone-free."
        >
          <input
            id="timezone"
            name="timezone"
            required
            defaultValue={settings?.timezone ?? 'America/New_York'}
            className="th-input"
          />
        </Field>

        <fieldset className="space-y-4 rounded-lg border border-border p-4">
          <legend className="px-1 text-sm font-semibold">Benefit year</legend>
          <p className="text-xs text-muted">
            When the leave year begins. Annual allotments and rollover happen on this
            date. A fiscal year such as 1 July is simply a different setting here.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Start month" name="benefitYearStartMonth">
              <select
                id="benefitYearStartMonth"
                name="benefitYearStartMonth"
                defaultValue={settings?.benefitYearStartMonth ?? 1}
                className="th-input"
              >
                {MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Start day" name="benefitYearStartDay">
              <input
                id="benefitYearStartDay"
                name="benefitYearStartDay"
                type="number"
                min={1}
                max={31}
                required
                defaultValue={settings?.benefitYearStartDay ?? 1}
                className="th-input"
              />
            </Field>
          </div>
        </fieldset>

        <fieldset className="space-y-4 rounded-lg border border-border p-4">
          <legend className="px-1 text-sm font-semibold">Time increments</legend>

          <Field
            label="Minimum leave request (minutes)"
            name="minimumRequestIncrementMinutes"
            hint="240 = half a standard day. Requests must be a multiple of this. Accruals are exempt and stay exact to the minute."
          >
            <input
              id="minimumRequestIncrementMinutes"
              name="minimumRequestIncrementMinutes"
              type="number"
              min={1}
              max={1440}
              required
              defaultValue={settings?.minimumRequestIncrementMinutes ?? 240}
              className="th-input"
            />
          </Field>

          <Checkbox
            name="allowSubIncrementWhenBalanceIsLower"
            label="Allow spending a remainder smaller than one increment"
            defaultChecked={settings?.allowSubIncrementWhenBalanceIsLower ?? true}
            hint="Without this, a balance below one increment can never be used and sits on the books forever."
          />

          <Field
            label="Timesheet increment (minutes)"
            name="timesheetIncrementMinutes"
            hint="Hours actually worked. Deliberately finer than the leave increment — rounding worked time to half-days would make payroll wrong."
          >
            <input
              id="timesheetIncrementMinutes"
              name="timesheetIncrementMinutes"
              type="number"
              min={1}
              max={1440}
              required
              defaultValue={settings?.timesheetIncrementMinutes ?? 15}
              className="th-input"
            />
          </Field>

          <Field
            label="Timesheets due (days after the period ends)"
            name="timesheetDueDaysAfterPeriodEnd"
            hint="Due by the end of that day. 0 is the period's last day; 3 after a Saturday is the Tuesday. Late timesheets are still accepted, and marked late."
          >
            <input
              id="timesheetDueDaysAfterPeriodEnd"
              name="timesheetDueDaysAfterPeriodEnd"
              type="number"
              min={0}
              max={60}
              required
              defaultValue={settings?.timesheetDueDaysAfterPeriodEnd ?? 3}
              className="th-input"
            />
          </Field>

          <Field label="Display durations as" name="displayUnit">
            <select
              id="displayUnit"
              name="displayUnit"
              defaultValue={settings?.displayUnit ?? 'DAYS'}
              className="th-input"
            >
              <option value="DAYS">Days (0.5 days)</option>
              <option value="HOURS">Hours (4h)</option>
            </select>
          </Field>
        </fieldset>

        <fieldset className="space-y-3 rounded-lg border border-border p-4">
          <legend className="px-1 text-sm font-semibold">Working week</legend>
          <p className="text-xs text-muted">
            The days a leave request fills in by default. A range spanning a weekend starts
            with the weekend set to no leave; any day can still be requested.
          </p>
          <Field label="Working days" name="workWeekDays">
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
              {WEEKDAYS.map((day) => (
                <Checkbox
                  key={day.iso}
                  name={`workWeekDay${day.iso}`}
                  label={day.label}
                  defaultChecked={(settings?.workWeekDays ?? [1, 2, 3, 4, 5]).includes(day.iso)}
                />
              ))}
            </div>
          </Field>
        </fieldset>

        <fieldset className="space-y-4 rounded-lg border border-border p-4">
          <legend className="px-1 text-sm font-semibold">Overtime and comp time</legend>

          <Field
            label="Comp time multiplier (basis points)"
            name="compTimeMultiplierBps"
            hint="10000 = 1.0x. Stored in basis points so the arithmetic stays whole-number."
          >
            <input
              id="compTimeMultiplierBps"
              name="compTimeMultiplierBps"
              type="number"
              min={0}
              max={100000}
              step={100}
              required
              defaultValue={settings?.compTimeMultiplierBps ?? 10000}
              className="th-input"
            />
          </Field>

          <Field
            label="Weekly overtime threshold (minutes)"
            name="overtimeWeeklyThresholdMinutes"
            hint="2400 = 40 hours."
          >
            <input
              id="overtimeWeeklyThresholdMinutes"
              name="overtimeWeeklyThresholdMinutes"
              type="number"
              min={0}
              max={10080}
              required
              defaultValue={settings?.overtimeWeeklyThresholdMinutes ?? 2400}
              className="th-input"
            />
          </Field>

          <Field
            label="Workweek starts on"
            name="workweekStartDay"
            hint="Overtime on hourly timesheets is counted per workweek. The workweek is fixed by the employer and need not match the pay period."
          >
            <select
              id="workweekStartDay"
              name="workweekStartDay"
              defaultValue={settings?.workweekStartDay ?? 7}
              className="th-input"
            >
              {WEEKDAYS.map((day) => (
                <option key={day.iso} value={day.iso}>
                  {day.label}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Bank approved overtime as"
            name="compLeaveTypeId"
            hint="Salaried exempt staff log overtime, and once approved it is banked into this leave type. Only types restricted to exempt staff are offered."
          >
            <select
              id="compLeaveTypeId"
              name="compLeaveTypeId"
              defaultValue={settings?.compLeaveTypeId ?? ''}
              className="th-input"
            >
              <option value="">Off — overtime cannot be logged</option>
              {compTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Banked comp expires after (days)"
            name="compExpiresAfterDays"
            hint="Counted from the day the overtime was worked. Leave blank for no expiry of its own — the rollover rule and carryover windows for the type still apply."
          >
            <input
              id="compExpiresAfterDays"
              name="compExpiresAfterDays"
              type="number"
              min={1}
              max={3660}
              defaultValue={settings?.compExpiresAfterDays ?? ''}
              className="th-input"
            />
          </Field>
        </fieldset>

        <SubmitButton label="Save settings" />
      </ConfigForm>
    </div>
  )
}
