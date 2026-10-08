/**
 * Overtime logs: submission, decisions, cancellation and administrator
 * overrides — and, on the last approval, banking the time as comp.
 *
 * Shaped exactly like `lib/requests/service.ts`, and through the same pure
 * chain functions (`lib/requests/chain.ts`): a snapshot at submission, the
 * same advance, the same self-approval rules. Only the subject differs, and
 * what the final approval writes — a `COMP_EARNED` entry instead of `USAGE`.
 *
 * **Rule 4.** Comp time is for exempt staff only. Checked here when a log is
 * submitted and again when it is approved, since someone can move from
 * salaried to hourly while a log is pending; and refused by the database at
 * both points too (`overtime_logs_require_exempt`, and the ledger's
 * `COMP_EARNED` trigger).
 *
 * **Concurrency.** The employee row, then the log row, locked in that order —
 * the same order as leave requests, so the two can never deadlock.
 */

import type { Prisma } from '@prisma/client'

import { writeAudit } from '@/lib/audit'
import { notifyResolved, notifyStepWaiting } from '@/lib/notifications/events'
import { OVERTIME_SOURCE, planCompEarned, type CompPlan } from '@/lib/accrual/comp'
import { addDays, benefitYearContaining, toUtcDay, todayIn } from '@/lib/accrual/dates'
import { db } from '@/lib/db'
import { entriesFor, writeEntries } from '@/lib/ledger/entries'
import { orgSettingsOrThrow } from '@/lib/ledger/policies'
import { applyDecision, currentStep, mayDecide, snapshotChain, type Actor } from '@/lib/requests/chain'
import { RequestError } from '@/lib/requests/service'

import { overtimeLogInput } from './schema'

type Tx = Prisma.TransactionClient
type Client = Tx | typeof db
type Org = Awaited<ReturnType<typeof orgSettingsOrThrow>>

export { RequestError }

const iso = (date: Date) => date.toISOString().slice(0, 10)
const isoToDate = (value: string) => new Date(`${value}T00:00:00.000Z`)

async function lockEmployee(tx: Tx, employeeId: string) {
  await tx.$queryRaw`SELECT 1 FROM "employees" WHERE "id" = ${employeeId} FOR UPDATE`
}

async function lockLog(tx: Tx, logId: string) {
  await tx.$queryRaw`SELECT 1 FROM "overtime_logs" WHERE "id" = ${logId} FOR UPDATE`
}

function years(org: Org, today: Date) {
  const current = benefitYearContaining(today, org.benefitYearStartMonth, org.benefitYearStartDay)
  const previous = benefitYearContaining(
    addDays(current.start, -1),
    org.benefitYearStartMonth,
    org.benefitYearStartDay,
  )
  return { current, previous }
}

/**
 * The comp type, if overtime logging is switched on and the type is one only
 * exempt staff can hold. A type an administrator has since opened to hourly
 * staff is treated as no type at all: banking into it would be rule 4 broken
 * by a settings change.
 */
async function compLeaveType(org: Org, client: Client) {
  if (!org.compLeaveTypeId) return null
  const type = await client.leaveType.findUnique({
    where: { id: org.compLeaveTypeId },
    select: {
      id: true,
      name: true,
      isActive: true,
      accruableBy: true,
      countsTowardRollover: true,
      rolloverRule: {
        select: { capBasis: true, capValue: true, carriedExpiresAfterDays: true },
      },
      carryoverWindows: {
        where: { isActive: true },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          earnedFromMonth: true,
          earnedFromDay: true,
          earnedToMonth: true,
          earnedToDay: true,
          usableUntilMonth: true,
          usableUntilDay: true,
          usableUntilYearOffset: true,
          capBasis: true,
          capValue: true,
        },
      },
    },
  })
  if (!type?.isActive || type.accruableBy !== 'EXEMPT_ONLY') return null
  return type
}

/** Whether overtime can be logged at all, and by whom — for the pages. */
export async function overtimeAvailability(
  employmentType: 'HOURLY' | 'SALARIED_EXEMPT',
): Promise<{ ok: true; leaveTypeName: string } | { ok: false; reason: string }> {
  if (employmentType !== 'SALARIED_EXEMPT') {
    return {
      ok: false,
      reason:
        'Comp time is only for salaried exempt staff. Hours worked beyond your schedule go on your timesheet, where they are paid as overtime.',
    }
  }
  const org = await orgSettingsOrThrow()
  const type = await compLeaveType(org, db)
  if (!type) {
    return {
      ok: false,
      reason: 'Overtime logging is switched off. An administrator can turn it on in the settings.',
    }
  }
  return { ok: true, leaveTypeName: type.name }
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

/**
 * Records overtime `actor` worked. The employee is always the actor — there
 * is no way to log time for someone else (rule 8).
 */
export async function submitOvertimeLog(actor: Actor, values: unknown): Promise<{ id: string }> {
  const org = await orgSettingsOrThrow()

  return db.$transaction(async (tx) => {
    await lockEmployee(tx, actor.id)

    const employee = await tx.employee.findUniqueOrThrow({
      where: { id: actor.id },
      select: { employmentType: true, standardMinutesPerDay: true },
    })

    // Rule 4, at the API boundary. The database refuses the row as well.
    if (employee.employmentType !== 'SALARIED_EXEMPT') {
      throw new RequestError(
        'Comp time is only for salaried exempt staff. Record hours worked on your timesheet instead.',
      )
    }

    const type = await compLeaveType(org, tx)
    if (!type) {
      throw new RequestError('Overtime logging is switched off.')
    }

    const parsed = overtimeLogInput({
      incrementMinutes: org.timesheetIncrementMinutes,
      minutesPerDay: employee.standardMinutesPerDay,
    }).safeParse(values)
    if (!parsed.success) {
      throw new RequestError('Please correct the errors below.', parsed.error.flatten().fieldErrors)
    }

    const { worked: minutes, note } = parsed.data
    const date = isoToDate(parsed.data.date)
    const today = todayIn(org.timezone)
    const { previous } = years(org, today)

    if (toUtcDay(date) > toUtcDay(today)) {
      throw new RequestError('Overtime can only be logged once it has been worked.', {
        date: ['Choose today or an earlier date.'],
      })
    }
    // Anything older has been through two rollovers and could bank nothing.
    if (toUtcDay(date) < toUtcDay(previous.start)) {
      throw new RequestError(`Overtime can be logged back to ${iso(previous.start)}.`, {
        date: [`Choose a date on or after ${iso(previous.start)}.`],
      })
    }

    const clash = await tx.overtimeLog.findFirst({
      where: { employeeId: actor.id, date, status: { in: ['PENDING', 'APPROVED'] } },
      select: { id: true },
    })
    if (clash) {
      throw new RequestError('You have already logged overtime for that day.', {
        date: ['Cancel the earlier log first, or add the time to it in a new log for one day.'],
      })
    }

    const chain = await tx.approvalChainStep.findMany({
      where: { employeeId: actor.id },
      select: { step: true, approverId: true },
    })
    const steps = snapshotChain(chain, actor.id)
    const now = new Date()

    const log = await tx.overtimeLog.create({
      data: {
        employeeId: actor.id,
        date,
        minutes,
        note,
        submittedAt: now,
        steps: {
          create: steps.map((s) => ({
            step: s.step,
            approverId: s.approverId,
            status: s.status,
            comment: s.comment,
            decidedAt: s.status === 'SKIPPED' ? now : null,
          })),
        },
      },
    })

    await writeAudit(
      {
        actorId: actor.id,
        action: 'overtimeLog.submit',
        entityType: 'OvertimeLog',
        entityId: log.id,
        after: { date: iso(date), minutes, status: 'PENDING', steps },
      },
      tx,
    )

    const first = await tx.approvalStep.findFirstOrThrow({
      where: { overtimeLogId: log.id, status: 'PENDING' },
      orderBy: { step: 'asc' },
      select: { id: true, approverId: true },
    })
    await notifyStepWaiting({ kind: 'OVERTIME', id: log.id }, first, tx)

    return { id: log.id }
  })
}

// ---------------------------------------------------------------------------
// What approval would bank
// ---------------------------------------------------------------------------

/**
 * What approving `log` now would write. Used by the approval itself, inside
 * its transaction, and by the log's page so the approver sees the figure —
 * including when a closed year means less than the time worked — before
 * deciding.
 */
export async function compPlanFor(
  log: { id: string; employeeId: string; date: Date; minutes: number },
  client: Client = db,
): Promise<CompPlan | null> {
  const org = await orgSettingsOrThrow()
  const type = await compLeaveType(org, client)
  if (!type) return null

  const employee = await client.employee.findUniqueOrThrow({
    where: { id: log.employeeId },
    select: {
      id: true,
      hireDate: true,
      terminationDate: true,
      standardMinutesPerDay: true,
      employmentType: true,
    },
  })
  const entries = await entriesFor(log.employeeId, type.id, client)
  const today = todayIn(org.timezone)
  const { current, previous } = years(org, today)

  return planCompEarned({
    log,
    leaveTypeId: type.id,
    multiplierBps: org.compTimeMultiplierBps,
    expiresAfterDays: org.compExpiresAfterDays,
    currentYear: current,
    previousYear: previous,
    employee,
    leaveType: { id: type.id, countsTowardRollover: type.countsTowardRollover },
    rule: type.rolloverRule,
    windows: type.carryoverWindows,
    entries,
    today,
  })
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type OvertimeDecideArgs = {
  logId: string
  decision: 'APPROVE' | 'DENY' | 'SKIP'
  comment?: string
  /** Set when an administrator acts outside the chain. Required for every override. */
  overrideReason?: string
}

export type OvertimeDecideResult = 'ADVANCED' | 'APPROVED' | 'DENIED'

export async function decideOvertimeLog(
  actor: Actor,
  args: OvertimeDecideArgs,
): Promise<OvertimeDecideResult> {
  const org = await orgSettingsOrThrow()
  const override = args.overrideReason !== undefined

  if (args.decision === 'SKIP' && !override) {
    throw new RequestError('Only an administrator can skip a step, and only with a reason.')
  }

  return db.$transaction(async (tx) => {
    const log = await lockedLog(tx, args.logId)

    if (log.status !== 'PENDING') throw new RequestError('This overtime has already been decided.')

    const current = currentStep(log.steps)
    if (!current) throw new RequestError('This overtime has already been decided.')

    if (override) {
      if (actor.role !== 'ADMIN') {
        throw new RequestError('Only an administrator can override a step.')
      }
      if (actor.id === log.employeeId) {
        throw new RequestError('You cannot override a step on your own overtime.')
      }
    } else if (!mayDecide(current, actor, log.employeeId)) {
      throw new RequestError(
        actor.id === log.employeeId
          ? 'You cannot decide your own overtime.'
          : 'This overtime is not waiting on you.',
      )
    }

    const outcome = applyDecision(log.steps, args.decision)
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
    if (decided.count !== 1) throw new RequestError('This overtime has already been decided.')

    if (outcome.closed.length > 0) {
      await tx.approvalStep.updateMany({
        where: { id: { in: outcome.closed } },
        data: {
          status: 'SKIPPED',
          decidedAt: now,
          comment: `Not reached: the overtime was denied at step ${current.step}.`,
        },
      })
    }

    let earned: number | null = null

    if (outcome.result === 'APPROVED') {
      // Rule 4 again: the employee may have become hourly since submitting.
      // Throwing rolls back the step update above.
      if (log.employee.employmentType !== 'SALARIED_EXEMPT') {
        throw new RequestError(
          `${log.employee.firstName} ${log.employee.lastName} is no longer salaried exempt, so this cannot be banked as comp time. Deny it; the hours belong on a timesheet.`,
        )
      }

      const plan = await compPlanFor(log, tx)
      if (!plan) {
        throw new RequestError(
          'Overtime logging is switched off, so there is no comp type to bank this into.',
        )
      }

      // Comp that expired before it was approved would be granted and
      // forfeited the next night, never spendable. Refused rather than
      // written, so the approver decides what is owed instead of the ledger
      // recording a grant nobody could use. Throwing rolls back the step.
      if (plan.expiredOn) throw new RequestError(plan.explanation ?? 'This time has expired.')

      await writeEntries(plan.entries, { createdById: actor.id }, tx)
      earned = plan.earnedMinutes

      await tx.overtimeLog.update({
        where: { id: log.id },
        data: {
          status: 'APPROVED',
          resolvedAt: now,
          multiplierBps: org.compTimeMultiplierBps,
          earnedMinutes: plan.earnedMinutes,
        },
      })
    }

    if (outcome.result === 'DENIED') {
      await tx.overtimeLog.update({
        where: { id: log.id },
        data: { status: 'DENIED', resolvedAt: now },
      })
    }

    await writeAudit(
      {
        actorId: actor.id,
        action: `overtimeLog.${override ? 'override.' : ''}${args.decision.toLowerCase()}`,
        entityType: 'OvertimeLog',
        entityId: log.id,
        before: { status: 'PENDING', step: current.step, approverId: current.approverId },
        after: {
          status: outcome.result === 'ADVANCED' ? 'PENDING' : outcome.result,
          step: current.step,
          stepStatus: outcome.decided.status,
          nextStep: outcome.next?.step ?? null,
          comment: args.comment,
          ...(earned !== null
            ? { earnedMinutes: earned, multiplierBps: org.compTimeMultiplierBps }
            : {}),
        },
        reason: args.overrideReason,
      },
      tx,
    )

    const subject = { kind: 'OVERTIME', id: log.id } as const
    if (outcome.result === 'ADVANCED' && outcome.next) {
      await notifyStepWaiting(subject, outcome.next, tx)
    } else if (outcome.result !== 'ADVANCED') {
      await notifyResolved(
        subject,
        outcome.result,
        outcome.decided.stepId,
        tx,
        override ? null : args.comment,
      )
    }

    return outcome.result
  })
}

/** Sends the current step to someone else. Administrator only, with a reason. */
export async function rerouteOvertimeLog(
  actor: Actor,
  args: { logId: string; approverId: string; reason: string },
): Promise<void> {
  if (actor.role !== 'ADMIN') throw new RequestError('Only an administrator can reroute overtime.')

  await db.$transaction(async (tx) => {
    const log = await lockedLog(tx, args.logId)

    if (actor.id === log.employeeId) throw new RequestError('You cannot reroute your own overtime.')
    if (log.status !== 'PENDING') throw new RequestError('This overtime has already been decided.')

    const current = currentStep(log.steps)
    if (!current) throw new RequestError('This overtime has already been decided.')

    if (args.approverId === log.employeeId) {
      throw new RequestError('Overtime cannot be routed to the person who worked it.', {
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
        action: 'overtimeLog.override.reroute',
        entityType: 'OvertimeLog',
        entityId: log.id,
        before: { step: current.step, approverId: current.approverId },
        after: { step: current.step, approverId: args.approverId },
        reason: args.reason,
      },
      tx,
    )

    await notifyStepWaiting(
      { kind: 'OVERTIME', id: log.id },
      { id: current.id, approverId: args.approverId },
      tx,
      'rerouted',
    )
  })
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

/**
 * Withdraws a log.
 *
 * Anyone may withdraw their own pending log, and an administrator anyone
 * else's, with a reason. An approved log can be cancelled only by an
 * administrator, never their own, and only while the comp it banked is in the
 * current benefit year: the banked minutes are taken back with an
 * `ADJUSTMENT` against each comp entry it wrote, dated on that entry's own
 * day. That may take the balance negative if the comp has been spent, which is
 * the honest answer and is shown on the ledger. Comp banked in a year that has
 * since closed went through that year's rollover, so taking it back is a
 * judgement for a ledger adjustment instead.
 */
export async function cancelOvertimeLog(
  actor: Actor,
  args: { logId: string; reason?: string },
): Promise<void> {
  const org = await orgSettingsOrThrow()
  const yearStart = benefitYearContaining(
    todayIn(org.timezone),
    org.benefitYearStartMonth,
    org.benefitYearStartDay,
  ).start

  await db.$transaction(async (tx) => {
    const log = await lockedLog(tx, args.logId)
    const own = actor.id === log.employeeId

    if (!own && actor.role !== 'ADMIN') {
      throw new RequestError('You can only cancel your own overtime.')
    }
    if (!own && !args.reason) {
      throw new RequestError('Say why you are cancelling someone else’s overtime.', {
        reason: ['A reason is required.'],
      })
    }
    let reversedMinutes = 0
    if (log.status === 'APPROVED') {
      if (actor.role !== 'ADMIN' || own) {
        throw new RequestError(
          'Approved overtime can only be cancelled by an administrator, and not their own.',
        )
      }
      const earned = await tx.ledgerEntry.findMany({
        where: { sourceType: OVERTIME_SOURCE, sourceId: log.id, kind: 'COMP_EARNED' },
        select: { employeeId: true, leaveTypeId: true, effectiveDate: true, minutes: true },
      })
      if (earned.some((e) => e.effectiveDate < yearStart)) {
        throw new RequestError(
          'The comp time this overtime banked is in a benefit year that has closed. Take it back with a ledger adjustment instead.',
        )
      }
      await writeEntries(
        earned.map((e) => ({
          employeeId: e.employeeId,
          leaveTypeId: e.leaveTypeId,
          effectiveDate: e.effectiveDate,
          minutes: -e.minutes,
          kind: 'ADJUSTMENT' as const,
          expiresOn: null,
          periodKey: null,
          note: `Overtime cancelled: ${args.reason}`,
          sourceType: OVERTIME_SOURCE,
          sourceId: log.id,
        })),
        { createdById: actor.id },
        tx,
      )
      reversedMinutes = earned.reduce((sum, e) => sum + e.minutes, 0)
    } else if (log.status !== 'PENDING') {
      throw new RequestError('Only pending or approved overtime can be cancelled.')
    }

    const now = new Date()

    await tx.approvalStep.updateMany({
      where: { overtimeLogId: log.id, status: 'PENDING' },
      data: { status: 'SKIPPED', decidedAt: now, comment: 'Not reached: the log was cancelled.' },
    })
    await tx.overtimeLog.update({
      where: { id: log.id },
      // Only an approved log records what it banked (a CHECK constraint);
      // what this one had banked is in the audit row and the ledger.
      data: { status: 'CANCELLED', resolvedAt: now, earnedMinutes: null, multiplierBps: null },
    })

    await writeAudit(
      {
        actorId: actor.id,
        action: log.status === 'APPROVED' ? 'overtimeLog.override.cancel' : 'overtimeLog.cancel',
        entityType: 'OvertimeLog',
        entityId: log.id,
        before: { status: log.status },
        after: { status: 'CANCELLED', reversedMinutes },
        reason: args.reason,
      },
      tx,
    )
  })
}

/** Locks the employee and then the log — the one order every operation uses. */
async function lockedLog(tx: Tx, logId: string) {
  const head = await tx.overtimeLog.findUnique({
    where: { id: logId },
    select: { employeeId: true },
  })
  if (!head) throw new RequestError('That overtime log no longer exists.')

  await lockEmployee(tx, head.employeeId)
  await lockLog(tx, logId)

  // Sequential queries: one connection per transaction.
  const log = await tx.overtimeLog.findUniqueOrThrow({
    where: { id: logId },
    select: {
      id: true,
      employeeId: true,
      date: true,
      minutes: true,
      status: true,
      employee: { select: { employmentType: true, firstName: true, lastName: true } },
    },
  })
  const steps = await tx.approvalStep.findMany({
    where: { overtimeLogId: logId },
    select: { id: true, step: true, approverId: true, status: true },
    orderBy: { step: 'asc' },
  })

  return { ...log, steps }
}
