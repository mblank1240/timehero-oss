/**
 * Timesheets: filling one in, submitting it, the decisions on it, and an
 * administrator's unlock.
 *
 * Shaped like `lib/overtime/service.ts`, through the same pure chain functions
 * (`lib/requests/chain.ts`): a snapshot at submission, the same advance, the
 * same self-approval rules and the same overrides. What differs is that a
 * timesheet can go round more than once. A rejection sends it back to the
 * employee to correct; an administrator can unlock an approved one. Either way
 * the old steps stay where they are and the next submission numbers its own
 * after them, so the timesheet's history reads top to bottom.
 *
 * Nothing here touches the ledger. Leave on a timesheet is a copy of approved
 * requests, which already moved the balance; hours worked are paid, not
 * banked, and never become comp time (rule 4).
 *
 * **Concurrency.** The employee row, then the timesheet row, locked in that
 * order — the same order as leave requests and overtime, so none of them can
 * deadlock against another.
 */

import type { Prisma } from '@prisma/client'

import { writeAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import { orgSettingsOrThrow } from '@/lib/ledger/policies'
import { notifyResolved, notifyStepWaiting } from '@/lib/notifications/events'
import { applyDecision, currentStep, mayDecide, snapshotChain, type Actor } from '@/lib/requests/chain'
import { RequestError } from '@/lib/requests/service'

import { gridFor, isEditable, liveLinesFor, sheetHead, type SheetHead } from './data'
import { isEmployedOn, periodDates } from './grid'
import { timesheetGridInput, type GridDayInput } from './schema'
import { can } from '@/lib/permissions'

type Tx = Prisma.TransactionClient

export { RequestError }

const iso = (date: Date) => date.toISOString().slice(0, 10)
const isoToDate = (value: string) => new Date(`${value}T00:00:00.000Z`)

async function lockEmployee(tx: Tx, employeeId: string) {
  await tx.$queryRaw`SELECT 1 FROM "employees" WHERE "id" = ${employeeId} FOR UPDATE`
}

async function lockTimesheet(tx: Tx, timesheetId: string) {
  await tx.$queryRaw`SELECT 1 FROM "timesheets" WHERE "id" = ${timesheetId} FOR UPDATE`
}

/** The days of the period the employee can enter time on. */
export function editableDays(sheet: SheetHead): string[] {
  return periodDates(sheet.payPeriod)
    .filter((date) => isEmployedOn(sheet.employee, date))
    .map(iso)
}

// ---------------------------------------------------------------------------
// Filling in and submitting
// ---------------------------------------------------------------------------

/**
 * Saves the grid, and submits it when `submit` is set — in one transaction,
 * so pressing "Submit" with unsaved edits never submits the old figures.
 *
 * The employee fills in their own timesheet (rule 8). An administrator may
 * fill in and submit someone else's — for staff who do not use the app, or a
 * correction after an unlock — with a reason, recorded in the audit log with
 * the hours before and after. Never their own through this route: their own
 * is filled in like anyone's.
 */
export async function saveTimesheet(
  actor: Actor,
  args: {
    timesheetId: string
    values: Record<string, unknown>
    submit?: boolean
    reason?: string
  },
): Promise<void> {
  const org = await orgSettingsOrThrow()

  await db.$transaction(async (tx) => {
    const sheet = await lockedSheet(tx, args.timesheetId)

    const onBehalf = sheet.employeeId !== actor.id
    if (onBehalf && !can(actor, 'MANAGE_TIME_RECORDS')) {
      throw new RequestError('You can only fill in your own timesheet.')
    }
    if (onBehalf && (!args.reason || args.reason.length < 5)) {
      throw new RequestError('Say why you are changing someone else’s timesheet.', {
        reason: ['A reason is required.'],
      })
    }
    if (!isEditable(sheet.status)) {
      throw new RequestError(
        sheet.status === 'APPROVED'
          ? 'This timesheet has been approved and is locked. An administrator can unlock it.'
          : 'This timesheet has been submitted. Withdraw it first to make changes.',
      )
    }

    const parsed = timesheetGridInput(
      {
        incrementMinutes: org.timesheetIncrementMinutes,
        minutesPerDay: sheet.employee.standardMinutesPerDay,
      },
      editableDays(sheet),
    ).safeParse(args.values)
    if (!parsed.success) {
      const fieldErrors: Record<string, string[]> = {}
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '')
        fieldErrors[key] = [...(fieldErrors[key] ?? []), issue.message]
      }
      throw new RequestError('Please correct the highlighted days.', fieldErrors)
    }

    const before = onBehalf
      ? await tx.timeEntry.findMany({
          where: { timesheetId: sheet.id, category: 'REGULAR' },
          select: { date: true, minutes: true },
          orderBy: { date: 'asc' },
        })
      : []

    await writeWorked(tx, sheet.id, parsed.data)

    if (onBehalf) {
      await writeAudit(
        {
          actorId: actor.id,
          action: 'timesheet.override.edit',
          entityType: 'Timesheet',
          entityId: sheet.id,
          before: { worked: before.map((e) => ({ date: iso(e.date), minutes: e.minutes })) },
          after: {
            worked: parsed.data
              .filter((d) => d.minutes > 0)
              .map((d) => ({ date: d.date, minutes: d.minutes })),
          },
          reason: args.reason,
        },
        tx,
      )
    }

    if (args.submit) await submitInTx(tx, actor, sheet, onBehalf ? args.reason : undefined)
  })
}

/** Replaces the worked rows. A day with nothing worked and no note has none. */
async function writeWorked(tx: Tx, timesheetId: string, days: GridDayInput[]) {
  await tx.timeEntry.deleteMany({ where: { timesheetId, category: 'REGULAR' } })
  const rows = days.filter((d) => d.minutes > 0)
  if (rows.length === 0) return
  await tx.timeEntry.createMany({
    data: rows.map((d) => ({
      timesheetId,
      date: isoToDate(d.date),
      minutes: d.minutes,
      category: 'REGULAR' as const,
      note: d.note,
    })),
  })
}

async function submitInTx(tx: Tx, actor: Actor, sheet: SheetHead, onBehalfReason?: string) {
  // Freeze leave and holidays as they stand now. This is what the approvers
  // approve and what the export reports; leave approved for the period after
  // submission does not change it until the timesheet is opened again.
  const lines = await liveLinesFor(sheet, tx)
  await tx.timeEntry.deleteMany({
    where: { timesheetId: sheet.id, category: { in: ['LEAVE', 'HOLIDAY'] } },
  })
  await tx.timeEntry.createMany({
    data: [
      ...lines.holidays.map((h) => ({
        timesheetId: sheet.id,
        date: h.date,
        minutes: h.minutes,
        category: 'HOLIDAY' as const,
        note: h.name,
      })),
      ...lines.leave.map((l) => ({
        timesheetId: sheet.id,
        date: l.date,
        minutes: l.minutes,
        category: 'LEAVE' as const,
        leaveRequestId: l.leaveRequestId,
        leaveTypeId: l.leaveTypeId,
      })),
    ],
  })

  const chain = await tx.approvalChainStep.findMany({
    where: { employeeId: sheet.employeeId },
    select: { step: true, approverId: true },
  })
  const previous = await tx.approvalStep.aggregate({
    where: { timesheetId: sheet.id },
    _max: { step: true },
  })
  const offset = previous._max.step ?? 0
  const steps = snapshotChain(chain, sheet.employeeId).map((s) => ({ ...s, step: s.step + offset }))
  const now = new Date()

  await tx.approvalStep.createMany({
    data: steps.map((s) => ({
      timesheetId: sheet.id,
      step: s.step,
      approverId: s.approverId,
      status: s.status,
      comment: s.comment,
      decidedAt: s.status === 'SKIPPED' ? now : null,
    })),
  })

  // Entries first, status second: the database refuses entry changes on a
  // submitted timesheet.
  await tx.timesheet.update({
    where: { id: sheet.id },
    data: { status: 'SUBMITTED', submittedAt: now, resolvedAt: null },
  })

  const { totals } = await gridFor({ ...sheet, status: 'SUBMITTED' }, tx)

  await writeAudit(
    {
      actorId: actor.id,
      action: onBehalfReason ? 'timesheet.override.submit' : 'timesheet.submit',
      entityType: 'Timesheet',
      entityId: sheet.id,
      before: { status: sheet.status },
      after: {
        status: 'SUBMITTED',
        period: iso(sheet.payPeriod.startDate),
        worked: totals.worked,
        overtime: totals.overtime,
        leave: totals.leave,
        holiday: totals.holiday,
        steps,
      },
      reason: onBehalfReason,
    },
    tx,
  )

  const first = await tx.approvalStep.findFirstOrThrow({
    where: { timesheetId: sheet.id, status: 'PENDING' },
    orderBy: { step: 'asc' },
    select: { id: true, approverId: true },
  })
  await notifyStepWaiting({ kind: 'TIMESHEET', id: sheet.id }, first, tx)
}

/** Takes back a submitted timesheet before anyone has finished with it. */
export async function withdrawTimesheet(actor: Actor, args: { timesheetId: string }) {
  await db.$transaction(async (tx) => {
    const sheet = await lockedSheet(tx, args.timesheetId)

    if (sheet.employeeId !== actor.id) {
      throw new RequestError('You can only withdraw your own timesheet.')
    }
    if (sheet.status !== 'SUBMITTED') {
      throw new RequestError('Only a timesheet waiting for approval can be withdrawn.')
    }

    await reopen(tx, sheet.id, 'Not reached: the timesheet was withdrawn.')

    await writeAudit(
      {
        actorId: actor.id,
        action: 'timesheet.withdraw',
        entityType: 'Timesheet',
        entityId: sheet.id,
        before: { status: 'SUBMITTED' },
        after: { status: 'OPEN' },
      },
      tx,
    )
  })
}

/**
 * Opens a submitted or approved timesheet for editing again. Administrator
 * only, with a reason, and never one's own: an unlock is how approved hours
 * get changed, so it has to be someone else's decision.
 */
export async function unlockTimesheet(
  actor: Actor,
  args: { timesheetId: string; reason: string },
): Promise<void> {
  if (!can(actor, 'MANAGE_TIME_RECORDS')) throw new RequestError('Only an administrator can unlock a timesheet.')

  await db.$transaction(async (tx) => {
    const sheet = await lockedSheet(tx, args.timesheetId)

    if (sheet.employeeId === actor.id) {
      throw new RequestError('You cannot unlock your own timesheet.')
    }
    if (sheet.status !== 'APPROVED' && sheet.status !== 'SUBMITTED') {
      throw new RequestError('This timesheet is already open.')
    }

    await reopen(tx, sheet.id, 'Not reached: an administrator unlocked the timesheet.')

    await writeAudit(
      {
        actorId: actor.id,
        action: 'timesheet.unlock',
        entityType: 'Timesheet',
        entityId: sheet.id,
        before: { status: sheet.status },
        after: { status: 'OPEN' },
        reason: args.reason,
      },
      tx,
    )
  })
}

async function reopen(tx: Tx, timesheetId: string, comment: string) {
  const now = new Date()
  await tx.approvalStep.updateMany({
    where: { timesheetId, status: 'PENDING' },
    data: { status: 'SKIPPED', decidedAt: now, comment },
  })
  await tx.timesheet.update({
    where: { id: timesheetId },
    data: { status: 'OPEN', resolvedAt: null },
  })
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type TimesheetDecideArgs = {
  timesheetId: string
  decision: 'APPROVE' | 'DENY' | 'SKIP'
  comment?: string
  /** Set when an administrator acts outside the chain. Required for every override. */
  overrideReason?: string
}

export type TimesheetDecideResult = 'ADVANCED' | 'APPROVED' | 'DENIED'

/**
 * A denial is a rejection: the timesheet goes back to the employee to correct
 * and submit again, rather than ending as a leave request's denial does.
 * Hours that were worked still have to be paid.
 */
export async function decideTimesheet(
  actor: Actor,
  args: TimesheetDecideArgs,
): Promise<TimesheetDecideResult> {
  const override = args.overrideReason !== undefined

  if (args.decision === 'SKIP' && !override) {
    throw new RequestError('Only an administrator can skip a step, and only with a reason.')
  }

  return db.$transaction(async (tx) => {
    const sheet = await lockedSheet(tx, args.timesheetId)

    if (sheet.status !== 'SUBMITTED') {
      throw new RequestError('This timesheet is not waiting for approval.')
    }

    const steps = await stepsOf(tx, sheet.id)
    const current = currentStep(steps)
    if (!current) throw new RequestError('This timesheet is not waiting for approval.')

    if (override) {
      if (!can(actor, 'MANAGE_TIME_RECORDS')) {
        throw new RequestError('Only an administrator can override a step.')
      }
      if (actor.id === sheet.employeeId) {
        throw new RequestError('You cannot override a step on your own timesheet.')
      }
    } else if (!mayDecide(current, actor, sheet.employeeId)) {
      throw new RequestError(
        actor.id === sheet.employeeId
          ? 'You cannot approve your own timesheet.'
          : 'This timesheet is not waiting on you.',
      )
    }

    const outcome = applyDecision(steps, args.decision)
    const now = new Date()

    const decided = await tx.approvalStep.updateMany({
      where: { id: outcome.decided.stepId, status: 'PENDING' },
      data: {
        status: outcome.decided.status,
        decidedById: actor.id,
        decidedAt: now,
        comment: override ? args.overrideReason : (args.comment ?? null),
      },
    })
    if (decided.count !== 1) throw new RequestError('This timesheet has already been decided.')

    if (outcome.closed.length > 0) {
      await tx.approvalStep.updateMany({
        where: { id: { in: outcome.closed } },
        data: {
          status: 'SKIPPED',
          decidedAt: now,
          comment: `Not reached: the timesheet was sent back at step ${current.step}.`,
        },
      })
    }

    if (outcome.result !== 'ADVANCED') {
      await tx.timesheet.update({
        where: { id: sheet.id },
        data: {
          status: outcome.result === 'APPROVED' ? 'APPROVED' : 'REJECTED',
          resolvedAt: now,
        },
      })
    }

    await writeAudit(
      {
        actorId: actor.id,
        action: `timesheet.${override ? 'override.' : ''}${args.decision.toLowerCase()}`,
        entityType: 'Timesheet',
        entityId: sheet.id,
        before: { status: 'SUBMITTED', step: current.step, approverId: current.approverId },
        after: {
          status:
            outcome.result === 'ADVANCED'
              ? 'SUBMITTED'
              : outcome.result === 'APPROVED'
                ? 'APPROVED'
                : 'REJECTED',
          step: current.step,
          stepStatus: outcome.decided.status,
          nextStep: outcome.next?.step ?? null,
          comment: args.comment,
        },
        reason: args.overrideReason,
      },
      tx,
    )

    const subject = { kind: 'TIMESHEET', id: sheet.id } as const
    if (outcome.result === 'ADVANCED' && outcome.next) {
      await notifyStepWaiting(subject, outcome.next, tx)
    } else if (outcome.result !== 'ADVANCED') {
      await notifyResolved(
        subject,
        outcome.result === 'APPROVED' ? 'APPROVED' : 'REJECTED',
        outcome.decided.stepId,
        tx,
        override ? null : args.comment,
      )
    }

    return outcome.result
  })
}

/** Sends the current step to someone else. Administrator only, with a reason. */
export async function rerouteTimesheet(
  actor: Actor,
  args: { timesheetId: string; approverId: string; reason: string },
): Promise<void> {
  if (!can(actor, 'MANAGE_TIME_RECORDS')) {
    throw new RequestError('Only an administrator can reroute a timesheet.')
  }

  await db.$transaction(async (tx) => {
    const sheet = await lockedSheet(tx, args.timesheetId)

    if (actor.id === sheet.employeeId) {
      throw new RequestError('You cannot reroute your own timesheet.')
    }
    if (sheet.status !== 'SUBMITTED') {
      throw new RequestError('This timesheet is not waiting for approval.')
    }

    const current = currentStep(await stepsOf(tx, sheet.id))
    if (!current) throw new RequestError('This timesheet is not waiting for approval.')

    if (args.approverId === sheet.employeeId) {
      throw new RequestError('A timesheet cannot be routed to the person who filled it in.', {
        approverId: ['Choose someone other than the employee.'],
      })
    }
    if (args.approverId === current.approverId) {
      throw new RequestError('The step is already waiting on that person.', {
        approverId: ['Choose a different approver.'],
      })
    }

    const approver = await tx.employee.findUnique({
      where: { id: args.approverId },
      select: { isActive: true },
    })
    if (!approver?.isActive) {
      throw new RequestError('That approver is not an active employee.', {
        approverId: ['Choose an active employee.'],
      })
    }

    await tx.approvalStep.update({
      where: { id: current.id },
      data: { approverId: args.approverId },
    })

    await writeAudit(
      {
        actorId: actor.id,
        action: 'timesheet.override.reroute',
        entityType: 'Timesheet',
        entityId: sheet.id,
        before: { step: current.step, approverId: current.approverId },
        after: { step: current.step, approverId: args.approverId },
        reason: args.reason,
      },
      tx,
    )

    await notifyStepWaiting(
      { kind: 'TIMESHEET', id: sheet.id },
      { id: current.id, approverId: args.approverId },
      tx,
      'rerouted',
    )
  })
}

/** Locks the employee and then the timesheet — the one order every operation uses. */
async function lockedSheet(tx: Tx, timesheetId: string): Promise<SheetHead> {
  const head = await tx.timesheet.findUnique({
    where: { id: timesheetId },
    select: { employeeId: true },
  })
  if (!head) throw new RequestError('That timesheet no longer exists.')

  await lockEmployee(tx, head.employeeId)
  await lockTimesheet(tx, timesheetId)

  const sheet = await sheetHead(timesheetId, tx)
  if (!sheet) throw new RequestError('That timesheet no longer exists.')
  return sheet
}

async function stepsOf(tx: Tx, timesheetId: string) {
  return tx.approvalStep.findMany({
    where: { timesheetId },
    select: { id: true, step: true, approverId: true, status: true },
    orderBy: { step: 'asc' },
  })
}
