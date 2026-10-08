/**
 * What the leave request form needs to know about one employee: the leave
 * types they may hold with today's balances, the day amounts their working day
 * allows, holidays, and how far the calendar reaches.
 *
 * Shared by the employee's own form, an administrator recording leave for
 * them, and an administrator amending a request, so all three offer exactly
 * the same choices.
 */

import { addDays, todayIn } from '@/lib/accrual/dates'
import { db } from '@/lib/db'
import { incrementOptions } from '@/lib/duration'
import { balancesAsOf } from '@/lib/ledger/balance'
import { accruableBy, orgSettingsOrThrow } from '@/lib/ledger/policies'
import { GENERATE_MONTHS_AHEAD } from '@/lib/payperiods/sync'

import { MAX_REQUEST_DAYS } from './schema'

const iso = (date: Date) => date.toISOString().slice(0, 10)

export async function leaveFormProps(employee: {
  id: string
  employmentType: 'HOURLY' | 'SALARIED_EXEMPT'
  standardMinutesPerDay: number
}) {
  const org = await orgSettingsOrThrow()
  const today = todayIn(org.timezone)
  const latest = new Date(
    Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth() + GENERATE_MONTHS_AHEAD,
      today.getUTCDate(),
    ),
  )

  const [types, balances, holidays] = await Promise.all([
    db.leaveType.findMany({
      where: { isActive: true },
      select: { id: true, name: true, accruableBy: true },
      orderBy: { sortOrder: 'asc' },
    }),
    balancesAsOf(employee.id, today),
    db.holiday.findMany({
      // Past dates are requestable — sick leave is often recorded after the
      // fact — so the calendar reaches back a year as well as forward.
      where: { date: { gte: addDays(today, -366), lte: latest } },
      select: { date: true, name: true },
    }),
  ])

  // Comp time and anything else the employee cannot hold is not offered
  // (rule 4); the server refuses it too.
  const leaveTypes = types
    .filter((t) => accruableBy(t.accruableBy, employee.employmentType))
    .map((t) => ({ id: t.id, name: t.name, balanceMinutes: balances.get(t.id) ?? 0 }))

  const options = incrementOptions({
    incrementMinutes: org.minimumRequestIncrementMinutes,
    minutesPerDay: employee.standardMinutesPerDay,
  })
  const fullDay =
    options.find((o) => o.minutes === employee.standardMinutesPerDay) ?? options[options.length - 1]

  return {
    leaveTypes,
    options,
    defaultMinutes: fullDay?.minutes ?? 0,
    minutesPerDay: employee.standardMinutesPerDay,
    incrementMinutes: org.minimumRequestIncrementMinutes,
    allowSubIncrementWhenBalanceIsLower: org.allowSubIncrementWhenBalanceIsLower,
    displayUnit: org.displayUnit,
    workWeekDays: org.workWeekDays,
    holidays: Object.fromEntries(holidays.map((h) => [iso(h.date), h.name])),
    today: iso(today),
    latest: iso(latest),
    maxDays: MAX_REQUEST_DAYS,
  }
}
