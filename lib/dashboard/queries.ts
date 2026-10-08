/**
 * The dashboard's per-leave-type summary for the signed-in employee.
 *
 * Each type is loaded with `loadLeaveContext()` and run forward with
 * `projectEntries()` — exactly what the request form's balance check does —
 * so the dashboard cannot promise time the form would then refuse.
 */

import { balanceOf } from '@/lib/accrual/balance'
import { addDays } from '@/lib/accrual/dates'
import { projectEntries } from '@/lib/accrual/projection'
import type { CurrentUser } from '@/lib/authz'
import { db } from '@/lib/db'
import { accruableBy } from '@/lib/ledger/policies'
import { loadLeaveContext } from '@/lib/requests/context'

import { bookedAfter, nextAccrual, nextLoss, type NextAccrual, type ProjectedLoss } from './summary'

export type LeaveTypeSummary = {
  id: string
  name: string
  colorHex: string
  /**
   * Today's balance, counting anything today's jobs will write that they
   * have not written yet — the same figure the request form starts from.
   */
  balanceMinutes: number
  /** Approved leave after today, still inside the balance and spoken for. */
  bookedMinutes: number
  /** Held by requests still awaiting approval. */
  pendingMinutes: number
  nextAccrual: NextAccrual | null
  /** The next time the employee stands to lose time, net of booked leave. */
  loss: ProjectedLoss | null
}

/**
 * One summary per active leave type the employee can hold. Comp time is
 * absent for hourly staff (rule 4), just as the request form leaves it out.
 */
export async function leaveSummariesFor(
  user: Pick<CurrentUser, 'id' | 'employmentType'>,
  org: { benefitYearStartMonth: number; benefitYearStartDay: number },
  today: Date,
): Promise<LeaveTypeSummary[]> {
  const types = await db.leaveType.findMany({
    where: { isActive: true },
    select: { id: true, name: true, colorHex: true, accruableBy: true },
    orderBy: { sortOrder: 'asc' },
  })

  const benefitYearStart = { month: org.benefitYearStartMonth, day: org.benefitYearStartDay }
  // A rolling year ahead reaches the next rollover, the next lump grant, and
  // the expiry of anything carried into the coming year.
  const through = addDays(
    new Date(Date.UTC(today.getUTCFullYear() + 1, today.getUTCMonth(), today.getUTCDate())),
    -1,
  )

  return Promise.all(
    types
      .filter((type) => accruableBy(type.accruableBy, user.employmentType))
      .map(async (type): Promise<LeaveTypeSummary> => {
        const ctx = await loadLeaveContext({
          employeeId: user.id,
          leaveTypeId: type.id,
          today,
          benefitYearStart,
        })

        // The real ledger only. Pending requests may yet be denied, so they
        // neither delay an accrual ceiling nor rescue time from a forfeit.
        const projected = projectEntries({
          employee: ctx.employee,
          leaveType: { id: type.id, countsTowardRollover: ctx.leaveType.countsTowardRollover },
          policy: ctx.policy,
          rule: ctx.rule,
          windows: ctx.windows,
          schedule: ctx.schedule,
          benefitYearStart,
          entries: ctx.ledger,
          from: today,
          through,
        })

        return {
          id: type.id,
          name: type.name,
          colorHex: type.colorHex,
          balanceMinutes: balanceOf([...ctx.ledger, ...projected], today),
          bookedMinutes: bookedAfter(ctx.ledger, today),
          pendingMinutes: ctx.holds.reduce((sum, hold) => sum - hold.minutes, 0),
          nextAccrual: nextAccrual(projected, today),
          loss: nextLoss(projected, today),
        }
      }),
  )
}
