/**
 * The days an employee has taken, for the history screen.
 *
 * Read from approved requests rather than from the ledger's `USAGE` rows.
 * They hold the same days, but a cancellation reversal is not always dated on
 * the day it reverses — one from a closed benefit year lands on the new year's
 * first day (docs/DECISIONS.md) — so netting the ledger by date would paint a
 * phantom day. A cancelled request simply drops out of this query.
 */

import { db } from '@/lib/db'

export async function approvedDaysFor(employeeId: string) {
  const days = await db.leaveRequestDay.findMany({
    where: { leaveRequest: { employeeId, status: 'APPROVED' } },
    select: {
      date: true,
      minutes: true,
      leaveRequest: { select: { id: true, leaveTypeId: true } },
    },
    orderBy: { date: 'desc' },
  })

  return days.map((day) => ({
    date: day.date,
    minutes: day.minutes,
    requestId: day.leaveRequest.id,
    leaveTypeId: day.leaveRequest.leaveTypeId,
  }))
}

export type TakenDay = Awaited<ReturnType<typeof approvedDaysFor>>[number]
