import Link from 'next/link'

import { CarryoverWindowFields } from '@/components/config-fields'
import { ActionButton, ConfigForm, Field, SubmitButton } from '@/components/form'
import {
  deleteCarryoverWindow,
  saveCarryoverWindow,
  saveRolloverRule,
} from '@/lib/config/actions'
import { requireAdmin } from '@/lib/authz'
import { db } from '@/lib/db'

export const metadata = { title: 'Rollover · TimeHero' }

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

const CAP_LABELS: Record<string, string> = {
  NONE: 'Nothing carries over',
  UNLIMITED: 'Everything carries over',
  FIXED_MINUTES: 'Up to a fixed number of minutes',
  EMPLOYEE_DAYS: "Up to a number of the employee's own days",
}

function describeCap(basis: string, value: number): string {
  if (basis === 'NONE') return 'nothing carries over'
  if (basis === 'UNLIMITED') return 'unlimited'
  if (basis === 'EMPLOYEE_DAYS') {
    return `${value} ${value === 1 ? 'day' : 'days'} of the employee's own schedule`
  }
  return `${value} minutes`
}

function monthDay(month: number, day: number): string {
  return `${day} ${MONTHS[month - 1]}`
}

export default async function RolloverPage() {
  await requireAdmin()
  const types = await db.leaveType.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: {
      rolloverRule: true,
      carryoverWindows: { orderBy: { name: 'asc' } },
    },
  })

  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <div>
        <h1 className="text-2xl font-semibold">Rollover</h1>
        <p className="mt-1 text-sm text-muted">
          What survives the benefit-year boundary. Caps are organisation-wide per leave
          type. Expressing a cap in <em>days</em> rather than minutes keeps it fair
          across schedules — five days means five of that person&rsquo;s own days.
        </p>
      </div>

      {types.length === 0 && <p className="text-sm text-muted">Add a leave type first.</p>}

      {types.map((type) => (
        <section key={type.id} className="space-y-5 border-t border-border pt-8 first:border-0 first:pt-0">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="h-3 w-3 rounded-full"
              style={{ backgroundColor: type.colorHex }}
            />
            <h2 className="text-lg font-semibold">{type.name}</h2>
            <span className="text-xs text-muted">
              currently: {describeCap(
                type.rolloverRule?.capBasis ?? 'NONE',
                type.rolloverRule?.capValue ?? 0,
              )}
            </span>
          </div>

          <ConfigForm
            action={saveRolloverRule}
            successMessage="Rollover rule saved."
            className="space-y-4 rounded-lg border border-border p-4"
          >
            <input type="hidden" name="leaveTypeId" value={type.id} />

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Cap" name="capBasis">
                <select
                  id="capBasis"
                  name="capBasis"
                  defaultValue={type.rolloverRule?.capBasis ?? 'NONE'}
                  className="th-input"
                >
                  {Object.entries(CAP_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label="Cap value"
                name="capValue"
                hint="Days when the cap is in employee days, otherwise minutes. Ignored for none/unlimited."
              >
                <input
                  id="capValue"
                  name="capValue"
                  type="number"
                  min={0}
                  defaultValue={type.rolloverRule?.capValue ?? 0}
                  required
                  className="th-input"
                />
              </Field>
            </div>

            <Field
              label="Carried time expires after (days)"
              name="carriedExpiresAfterDays"
              hint="Blank means carried time never expires."
            >
              <input
                id="carriedExpiresAfterDays"
                name="carriedExpiresAfterDays"
                type="number"
                min={1}
                max={366}
                defaultValue={type.rolloverRule?.carriedExpiresAfterDays ?? ''}
                className="th-input"
              />
            </Field>

            <SubmitButton label={`Save ${type.name} rollover`} />
          </ConfigForm>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold">Carryover windows</h3>
            <p className="text-xs text-muted">
              An exception: time earned inside the window survives a rollover it would
              otherwise fail, usable until the date given. The church&rsquo;s December
              comp-time grace period is exactly one of these.
            </p>

            {type.carryoverWindows.length > 0 && (
              <ul className="th-card divide-y divide-border">
                {type.carryoverWindows.map((w) => (
                  <li
                    key={w.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
                  >
                    <div>
                      <div className="font-medium">
                        {w.name}
                        {!w.isActive && (
                          <span className="ml-2 text-xs text-danger">· inactive</span>
                        )}
                      </div>
                      <div className="text-xs text-muted">
                        Earned {monthDay(w.earnedFromMonth, w.earnedFromDay)} –{' '}
                        {monthDay(w.earnedToMonth, w.earnedToDay)}, usable until{' '}
                        {monthDay(w.usableUntilMonth, w.usableUntilDay)}
                        {w.usableUntilYearOffset === 1
                          ? ' the following year'
                          : w.usableUntilYearOffset > 1
                            ? ` ${w.usableUntilYearOffset} years later`
                            : ''}{' '}
                        · {describeCap(w.capBasis, w.capValue)}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                    <Link
                      href={`/admin/rollover/windows/${w.id}`}
                      className="text-sm text-accent hover:underline"
                    >
                      Edit<span className="sr-only"> {w.name}</span>
                    </Link>
                    <ActionButton
                      action={deleteCarryoverWindow.bind(null, w.id)}
                      label="Remove"
                      pendingLabel="Removing…"
                      variant="danger"
                      confirmLabel="Confirm removal"
                    />
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <details className="th-card p-4">
              <summary className="cursor-pointer text-sm font-medium">
                Add a window for {type.name}
              </summary>

              <ConfigForm
                action={saveCarryoverWindow.bind(null, null)}
                successMessage="Window added."
                className="mt-4 space-y-4"
              >
                <CarryoverWindowFields leaveTypeId={type.id} />

                <SubmitButton label="Add window" />
              </ConfigForm>
            </details>
          </div>
        </section>
      ))}
    </div>
  )
}
