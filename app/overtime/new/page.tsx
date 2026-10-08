import Link from 'next/link'

import { ConfigForm, Field, SubmitButton } from '@/components/form'
import { addDays, benefitYearContaining, todayIn } from '@/lib/accrual/dates'
import { requireUser } from '@/lib/authz'
import { orgSettingsOrThrow } from '@/lib/ledger/policies'
import { submitOvertime } from '@/lib/overtime/actions'
import { overtimeAvailability } from '@/lib/overtime/service'

export const metadata = { title: 'Log overtime · TimeHero' }

const iso = (date: Date) => date.toISOString().slice(0, 10)

export default async function NewOvertimePage() {
  const user = await requireUser()
  const [org, availability] = await Promise.all([
    orgSettingsOrThrow(),
    overtimeAvailability(user.employmentType),
  ])

  const today = todayIn(org.timezone)
  const thisYear = benefitYearContaining(today, org.benefitYearStartMonth, org.benefitYearStartDay)
  const earliest = benefitYearContaining(
    addDays(thisYear.start, -1),
    org.benefitYearStartMonth,
    org.benefitYearStartDay,
  ).start

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div className="space-y-2">
        <p className="text-sm">
          <Link href="/overtime" className="text-muted hover:text-foreground">
            ← Overtime
          </Link>
        </p>
        <h1 className="text-2xl font-semibold">Log overtime</h1>
        <p className="text-sm text-muted">
          {availability.ok
            ? `Record a day you worked beyond your normal hours. It goes to your approvers in order, and once approved it is banked as ${availability.leaveTypeName}.`
            : availability.reason}
        </p>
      </div>

      {availability.ok && (
        <ConfigForm action={submitOvertime}>
          <Field label="Date worked" name="date">
            <input
              id="date"
              name="date"
              type="date"
              required
              min={iso(earliest)}
              max={iso(today)}
              defaultValue={iso(today)}
              className="th-input"
            />
          </Field>
          <Field
            label="Time worked beyond your normal hours"
            name="worked"
            hint={`For example 2h 15m, or 2:15. In steps of ${org.timesheetIncrementMinutes} minutes.`}
          >
            <input id="worked" name="worked" required className="th-input" autoComplete="off" />
          </Field>
          <Field label="What it was for" name="note">
            <textarea id="note" name="note" required maxLength={500} rows={3} className="th-input" />
          </Field>
          <SubmitButton label="Submit for approval" pendingLabel="Submitting…" />
        </ConfigForm>
      )}
    </div>
  )
}
