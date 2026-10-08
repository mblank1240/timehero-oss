/**
 * Bringing a pay schedule's stored periods in line with its settings.
 *
 * Periods are stored rows rather than computed on demand, because computed
 * ones would shift retroactively the moment someone edited a schedule and
 * silently re-date historical accruals (docs/DECISIONS.md). The cost is that
 * something has to keep the rows in step, which is this.
 *
 * It runs from two places and must behave identically in both: the admin
 * screen, where an actor edits a schedule, and the weekly `generate-pay-periods`
 * job, where there is no actor at all. That is why the authorization check
 * lives in the caller and not here.
 */

import type { Prisma, PrismaClient } from '@prisma/client'

import { writeAudit } from '@/lib/audit'
import { db } from '@/lib/db'

import { generatePeriods, type PayScheduleInput } from './generate'

type Client = PrismaClient | Prisma.TransactionClient

/** How far ahead periods are kept generated. */
export const GENERATE_MONTHS_AHEAD = 24

export type SyncResult = {
  payScheduleId: string
  created: number
  updated: number
  removed: number
}

export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

/**
 * Syncs one schedule, `GENERATE_MONTHS_AHEAD` months out from `asOf`.
 *
 * Every period up to the horizon is written one row at a time in a single
 * transaction, so `asOf` must be a sane date: the scheduled job's comes
 * through `jobDate`, which refuses anything past tomorrow
 * (`JOB_DATE_MAX_DAYS_AHEAD`), and the admin screen's is now.
 *
 * Locked periods, periods with timesheets and periods already past are left
 * alone — history must not move when someone edits a schedule, and a
 * timesheet cannot have its period's boundaries redrawn underneath it.
 *
 * Returns null when the schedule no longer exists.
 */
export async function syncPayPeriodsFor(
  payScheduleId: string,
  opts: { actorId: string | null; asOf?: Date } = { actorId: null },
): Promise<SyncResult | null> {
  const schedule = await db.paySchedule.findUnique({ where: { id: payScheduleId } })
  if (!schedule) return null

  const today = startOfUtcDay(opts.asOf ?? new Date())
  const through = new Date(today)
  through.setUTCMonth(through.getUTCMonth() + GENERATE_MONTHS_AHEAD)

  const input: PayScheduleInput = {
    type: schedule.type,
    anchorDate: schedule.anchorDate,
    payDateOffsetDays: schedule.payDateOffsetDays,
  }

  // Generate from the anchor so existing rows are matched by start date rather
  // than recreated with shifted boundaries.
  const wanted = generatePeriods(input, { from: schedule.anchorDate, through })

  const existing = await db.payPeriod.findMany({
    where: { payScheduleId },
    select: {
      id: true,
      startDate: true,
      endDate: true,
      payDate: true,
      isLocked: true,
      _count: { select: { timesheets: true } },
    },
  })
  // A period someone has a timesheet on is as fixed as a locked one: the
  // hours on it were entered against those dates.
  const fixed = (p: (typeof existing)[number]) => p.isLocked || p._count.timesheets > 0
  const byStart = new Map(existing.map((p) => [p.startDate.toISOString(), p]))

  let created = 0
  let updated = 0
  let removed = 0

  await db.$transaction(async (tx: Client) => {
    for (const period of wanted) {
      const key = period.startDate.toISOString()
      const current = byStart.get(key)

      if (!current) {
        await tx.payPeriod.create({ data: { payScheduleId, ...period } })
        created += 1
        continue
      }

      byStart.delete(key)

      const unchanged =
        current.endDate.getTime() === period.endDate.getTime() &&
        current.payDate.getTime() === period.payDate.getTime()
      if (unchanged || fixed(current)) continue

      await tx.payPeriod.update({
        where: { id: current.id },
        data: { endDate: period.endDate, payDate: period.payDate },
      })
      updated += 1
    }

    // Anything left over no longer belongs to the schedule's shape. Only
    // future periods that nothing has been entered against may be removed —
    // and only within this run's horizon. A period past `through` is not a
    // misfit, just further out than a run for an earlier date looks; a
    // backfill must not delete what the last ordinary run generated.
    const orphanIds = [...byStart.values()]
      .filter((p) => !fixed(p) && p.startDate > today && p.startDate <= through)
      .map((p) => p.id)

    if (orphanIds.length > 0) {
      await tx.payPeriod.deleteMany({ where: { id: { in: orphanIds } } })
      removed = orphanIds.length
    }

    // Only worth a row when something actually moved; the weekly job is
    // otherwise a no-op and would fill the audit log with nothing.
    if (created > 0 || updated > 0 || removed > 0) {
      await writeAudit(
        {
          actorId: opts.actorId,
          action: 'payPeriods.sync',
          entityType: 'PaySchedule',
          entityId: payScheduleId,
          after: { created, updated, removed },
        },
        tx,
      )
    }
  })

  return { payScheduleId, created, updated, removed }
}

/** Every active schedule, for the weekly job. */
export async function syncAllPaySchedules(opts: { asOf?: Date } = {}): Promise<SyncResult[]> {
  const schedules = await db.paySchedule.findMany({
    where: { isActive: true },
    select: { id: true },
  })

  const results: SyncResult[] = []
  for (const schedule of schedules) {
    const result = await syncPayPeriodsFor(schedule.id, { actorId: null, asOf: opts.asOf })
    if (result) results.push(result)
  }

  return results
}
