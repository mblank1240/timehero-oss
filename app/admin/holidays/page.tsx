import { ActionButton, ConfigForm, Field, SubmitButton } from '@/components/form'
import { createHoliday, deleteHoliday } from '@/lib/config/actions'
import { db } from '@/lib/db'
import { formatDuration } from '@/lib/duration'

export const metadata = { title: 'Holidays · TimeHero' }

export default async function HolidaysPage() {
  const [holidays, settings] = await Promise.all([
    db.holiday.findMany({ orderBy: { date: 'asc' } }),
    db.orgSettings.findUnique({ where: { id: 1 } }),
  ])

  const unit = settings?.displayUnit ?? 'DAYS'
  const today = new Date().toISOString().slice(0, 10)

  const upcoming = holidays.filter((h) => h.date.toISOString().slice(0, 10) >= today)
  const past = holidays.filter((h) => h.date.toISOString().slice(0, 10) < today)

  return (
    <div className="mx-auto max-w-2xl space-y-10">
      <div>
        <h1 className="text-2xl font-semibold">Holidays</h1>
        <p className="mt-1 text-sm text-muted">
          Paid days the church is closed. They are excluded from leave-day counting, so
          a holiday inside a time-off request does not consume anyone&rsquo;s balance.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Upcoming</h2>
        <HolidayList holidays={upcoming} unit={unit} emptyMessage="None scheduled." />
      </section>

      {past.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Past</h2>
          <HolidayList holidays={past} unit={unit} emptyMessage="None." />
        </section>
      )}

      <section className="space-y-4 border-t border-border pt-8">
        <h2 className="text-lg font-semibold">Add a holiday</h2>
        <ConfigForm action={createHoliday} successMessage="Holiday added.">
          <Field label="Date" name="date">
            <input id="date" name="date" type="date" required className="th-input" />
          </Field>
          <Field label="Name" name="name">
            <input
              id="name"
              name="name"
              required
              maxLength={100}
              placeholder="Christmas Day"
              className="th-input"
            />
          </Field>
          <Field
            label="Paid length (minutes)"
            name="minutes"
            hint="480 = a standard 8-hour day. Use a smaller figure for a half-day closure."
          >
            <input
              id="minutes"
              name="minutes"
              type="number"
              min={0}
              max={1440}
              required
              defaultValue={480}
              className="th-input"
            />
          </Field>
          <SubmitButton label="Add holiday" />
        </ConfigForm>
      </section>
    </div>
  )
}

function HolidayList({
  holidays,
  unit,
  emptyMessage,
}: {
  holidays: { id: string; date: Date; name: string; minutes: number }[]
  unit: 'HOURS' | 'DAYS'
  emptyMessage: string
}) {
  if (holidays.length === 0) {
    return <p className="text-sm text-muted">{emptyMessage}</p>
  }

  return (
    <ul className="th-card divide-y divide-border">
      {holidays.map((h) => (
        <li key={h.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
          <div>
            <span className="font-medium">{h.name}</span>
            <span className="ml-2 text-muted">{h.date.toISOString().slice(0, 10)}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-muted">
              {formatDuration(h.minutes, { unit, minutesPerDay: 480 })}
            </span>
            <ActionButton
              action={deleteHoliday.bind(null, h.id)}
              label="Remove"
              pendingLabel="Removing…"
              variant="danger"
              confirmLabel="Confirm removal"
            />
          </div>
        </li>
      ))}
    </ul>
  )
}
