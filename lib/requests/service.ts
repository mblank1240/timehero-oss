/**
 * Leave requests: submission, decisions, cancellation and administrator
 * overrides.
 *
 * These take an already-authenticated actor and do the work; the Server
 * Actions in `./actions.ts` establish who the actor is (rule 8) and translate
 * the result for a form. Keeping the two apart is what lets the integration
 * tests drive a request through a three-step chain without a browser.
 *
 * **Concurrency.** Every operation locks the requester's employee row, then
 * the request row, in that order, before reading anything it will judge. The
 * employee lock serialises balance checks — two requests submitted at once
 * cannot both spend the same last day — and the request lock means two
 * approvers clicking at once produce one decision and one "already decided",
 * not two USAGE sets.
 */

import type { Prisma } from '@prisma/client'

import { writeAudit } from '@/lib/audit'
import { benefitYearContaining, maxDate, todayIn } from '@/lib/accrual/dates'
import type { ProposedEntry } from '@/lib/accrual/types'
import { db } from '@/lib/db'
import { formatDuration } from '@/lib/duration'
import { writeEntries } from '@/lib/ledger/entries'
import { accruableBy, orgSettingsOrThrow } from '@/lib/ledger/policies'
import { notifyResolved, notifyStepWaiting } from '@/lib/notifications/events'
import { GENERATE_MONTHS_AHEAD } from '@/lib/payperiods/sync'

import { applyDecision, currentStep, mayDecide, snapshotChain, type Actor } from './chain'
import { assess, isoToDate, loadLeaveContext } from './context'
import { leaveRequestInput } from './schema'
import { checkDays, type DayInput } from './validate'
import { can } from '@/lib/permissions'

type Tx = Prisma.TransactionClient

/** A refusal the person can act on. Anything else is a bug and is logged. */
export class RequestError extends Error {
  constructor(
    message: string,
    readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message)
    this.name = 'RequestError'
  }
}

const SOURCE_TYPE = 'LeaveRequest'

async function lockEmployee(tx: Tx, employeeId: string) {
  await tx.$queryRaw`SELECT 1 FROM "employees" WHERE "id" = ${employeeId} FOR UPDATE`
}

async function lockRequest(tx: Tx, requestId: string) {
  await tx.$queryRaw`SELECT 1 FROM "leave_requests" WHERE "id" = ${requestId} FOR UPDATE`
}

const iso = (date: Date) => date.toISOString().slice(0, 10)

type Org = Awaited<ReturnType<typeof orgSettingsOrThrow>>

function describer(org: Org, minutesPerDay: number) {
  return (minutes: number) => formatDuration(minutes, { unit: org.displayUnit, minutesPerDay })
}

function benefitYearStart(org: Org) {
  return { month: org.benefitYearStartMonth, day: org.benefitYearStartDay }
}

/** The furthest ahead a request may reach: as far as the pay calendar is generated. */
export function latestRequestableDate(today: Date): Date {
  return new Date(
    Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth() + GENERATE_MONTHS_AHEAD,
      today.getUTCDate(),
    ),
  )
}

function shortfallMessage(
  typeName: string,
  shortfall: { date: Date; balanceMinutes: number },
  describe: (m: number) => string,
  when: 'submit' | 'approve',
) {
  const lead =
    when === 'submit'
      ? 'There is not enough time for this request.'
      : 'The balance no longer covers this request, so it cannot be approved. Deny it, or have the balance corrected first.'
  return `${lead} It would leave ${typeName} at ${describe(shortfall.balanceMinutes)} on ${iso(shortfall.date)}.`
}

function usageEntries(
  request: { id: string; employeeId: string; leaveTypeId: string },
  days: readonly { date: Date; minutes: number }[],
): ProposedEntry[] {
  return days.map((day) => ({
    employeeId: request.employeeId,
    leaveTypeId: request.leaveTypeId,
    effectiveDate: day.date,
    minutes: -day.minutes,
    kind: 'USAGE',
    expiresOn: null,
    // Null: a request's entries are traced by `sourceId`, and its own row lock
    // is what stops them being written twice.
    periodKey: null,
    sourceType: SOURCE_TYPE,
    sourceId: request.id,
  }))
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

export type SubmitResult = { id: string; status: 'PENDING' | 'APPROVED' }

/**
 * An administrator entering leave for someone else — who called in sick, or
 * who does not use the app. Always with a reason.
 */
export type OnBehalf = {
  employeeId: string
  reason: string
  /**
   * Record it as approved now, with no approval steps, instead of sending it
   * through the employee's chain. For leave already agreed or already taken.
   */
  approveNow: boolean
  /** With `approveNow`: record it even if it takes the balance below zero. */
  allowOverdraw: boolean
}

/**
 * Days before the current benefit year cannot be booked or changed through a
 * request. That year's rollover has already run on the balance as it stood,
 * and usage dated into it now would leave the carry and the forfeit wrong
 * with nothing to correct them — the stale-rollover hazard the cancel path
 * also steers round. An adjustment, dated today and with a reason, is the
 * way to correct a closed year.
 */
function refuseClosedYear(
  dates: readonly Date[],
  yearStart: Date,
  when: 'book' | 'approve' = 'book',
) {
  const early = dates.filter((d) => d < yearStart)
  if (early.length > 0) {
    throw new RequestError(
      when === 'book'
        ? `${iso(early[0])} is in a benefit year that has already closed, so it cannot be booked as leave. Correct that year with a ledger adjustment instead.`
        : `${iso(early[0])} is in a benefit year that has already closed, so this request can no longer be approved. Deny it, and have an administrator correct that year with a ledger adjustment instead.`,
    )
  }
}

/**
 * Leave on a timesheet already submitted or approved would change what that
 * timesheet says after it was signed off. The administrator unlocks it first.
 */
async function refuseLockedTimesheets(tx: Tx, employeeId: string, dates: readonly Date[]) {
  if (dates.length === 0) return
  const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime())
  const locked = await tx.timesheet.findMany({
    where: {
      employeeId,
      status: { in: ['SUBMITTED', 'APPROVED'] },
      payPeriod: { startDate: { lte: sorted[sorted.length - 1] }, endDate: { gte: sorted[0] } },
    },
    select: { payPeriod: { select: { startDate: true, endDate: true } } },
  })
  const hit = locked.find((t) =>
    dates.some((d) => d >= t.payPeriod.startDate && d <= t.payPeriod.endDate),
  )
  if (hit) {
    throw new RequestError(
      `The timesheet for ${iso(hit.payPeriod.startDate)} to ${iso(hit.payPeriod.endDate)} is already submitted or approved. Unlock it first.`,
    )
  }
}

/**
 * Validates and records a request for `actor`'s own leave — or, for an
 * administrator passing `onBehalf`, for someone else's.
 *
 * Without `onBehalf` the employee is always the actor, so no form can name
 * someone else (rule 8). Increments are checked twice (rule 6): by the
 * schema, built from the org's current increment, and by `checkDays`, which
 * can see the balance the stranded-balance exception depends on. An
 * administrator is held to the same increments.
 */
export async function submitLeaveRequest(
  actor: Actor,
  values: unknown,
  onBehalf?: OnBehalf,
): Promise<SubmitResult> {
  const org = await orgSettingsOrThrow()

  if (onBehalf) {
    if (!can(actor, 'MANAGE_TIME_RECORDS')) {
      throw new RequestError('Only an administrator can enter leave for someone else.')
    }
    if (onBehalf.employeeId === actor.id) {
      throw new RequestError('Request your own leave from the request form, like anyone else.')
    }
  }
  const employeeId = onBehalf?.employeeId ?? actor.id

  const parsed = leaveRequestInput({
    incrementMinutes: org.minimumRequestIncrementMinutes,
    allowSubIncrementWhenBalanceIsLower: org.allowSubIncrementWhenBalanceIsLower,
  }).safeParse(values)

  if (!parsed.success) {
    throw new RequestError('Please correct the errors below.', parsed.error.flatten().fieldErrors)
  }

  const { leaveTypeId, note } = parsed.data
  const days = [...parsed.data.days].sort((a, b) => a.date.localeCompare(b.date))
  const today = todayIn(org.timezone)

  const latest = latestRequestableDate(today)
  if (isoToDate(days[days.length - 1].date) > latest) {
    throw new RequestError(
      `Requests can reach as far ahead as ${iso(latest)}, which is as far as the pay calendar goes.`,
    )
  }
  refuseClosedYear(
    days.map((d) => isoToDate(d.date)),
    benefitYearContaining(today, org.benefitYearStartMonth, org.benefitYearStartDay).start,
  )

  return db.$transaction(async (tx) => {
    await lockEmployee(tx, employeeId)

    // One query at a time: a transaction is one connection.
    const employee = await tx.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, standardMinutesPerDay: true, employmentType: true, isActive: true },
    })
    if (!employee || (onBehalf && !employee.isActive)) {
      throw new RequestError('That employee is not active.')
    }
    const leaveType = await tx.leaveType.findUnique({
      where: { id: leaveTypeId },
      select: {
        id: true,
        name: true,
        isActive: true,
        accruableBy: true,
        requiresApproval: true,
      },
    })

    // Rule 4 for spending: an hourly employee has no comp balance to spend,
    // but the refusal should say why rather than report a shortfall.
    if (
      !leaveType ||
      !leaveType.isActive ||
      !accruableBy(leaveType.accruableBy, employee.employmentType)
    ) {
      throw new RequestError(`That leave type is not available to ${onBehalf ? 'this employee' : 'you'}.`, {
        leaveTypeId: ['Choose a leave type from the list.'],
      })
    }

    const describe = describer(org, employee.standardMinutesPerDay)
    const dates = days.map((d) => isoToDate(d.date))

    const ctx = await loadLeaveContext(
      { employeeId, leaveTypeId, today, benefitYearStart: benefitYearStart(org) },
      tx,
    )
    const holidays = await tx.holiday.findMany({
      where: { date: { in: dates } },
      select: { date: true, name: true },
    })
    const booked = await tx.leaveRequestDay.findMany({
      where: {
        date: { in: dates },
        leaveRequest: { employeeId, status: { in: ['PENDING', 'APPROVED'] } },
      },
      select: { date: true, minutes: true },
    })
    if (onBehalf) await refuseLockedTimesheets(tx, employeeId, dates)

    const bookedMinutes = new Map<string, number>()
    for (const day of booked) {
      bookedMinutes.set(iso(day.date), (bookedMinutes.get(iso(day.date)) ?? 0) + day.minutes)
    }

    const assessment = assess(ctx, days)

    const errors = checkDays({
      days,
      incrementMinutes: org.minimumRequestIncrementMinutes,
      allowSubIncrementWhenBalanceIsLower: org.allowSubIncrementWhenBalanceIsLower,
      minutesPerDay: employee.standardMinutesPerDay,
      holidays: new Map(holidays.map((h) => [iso(h.date), h.name])),
      bookedMinutes,
      availableMinutes: assessment.availableMinutes,
      describe,
    })
    if (Object.keys(errors).length > 0) {
      throw new RequestError('Please correct the errors below.', errors)
    }

    const overdrawn = Boolean(assessment.shortfall)
    if (assessment.shortfall && !(onBehalf?.approveNow && onBehalf.allowOverdraw)) {
      throw new RequestError(
        shortfallMessage(leaveType.name, assessment.shortfall, describe, 'submit'),
      )
    }

    const now = new Date()
    const totalMinutes = days.reduce((sum, d) => sum + d.minutes, 0)
    const dayRows = days.map((d) => ({ date: isoToDate(d.date), minutes: d.minutes }))

    // A type that needs no approval is approved as it is submitted, with no
    // steps at all — there is nobody whose decision it waits on. Leave an
    // administrator records as already approved is the same.
    if (!leaveType.requiresApproval || onBehalf?.approveNow) {
      const request = await tx.leaveRequest.create({
        data: {
          employeeId,
          leaveTypeId,
          status: 'APPROVED',
          totalMinutes,
          note,
          submittedAt: now,
          resolvedAt: now,
          days: { create: dayRows },
        },
      })
      await writeEntries(usageEntries(request, dayRows), { createdById: actor.id }, tx)
      await writeAudit(
        {
          actorId: actor.id,
          action: onBehalf ? 'leaveRequest.override.record' : 'leaveRequest.submit',
          entityType: 'LeaveRequest',
          entityId: request.id,
          after: {
            employeeId,
            leaveTypeId,
            days,
            totalMinutes,
            status: 'APPROVED',
            approvalRequired: leaveType.requiresApproval,
            ...(onBehalf ? { recordedAsApproved: true, overdrawn } : {}),
          },
          reason: onBehalf?.reason,
        },
        tx,
      )
      return { id: request.id, status: 'APPROVED' }
    }

    // The chain as it stands now. Later edits to it do not reach this request.
    const chain = await tx.approvalChainStep.findMany({
      where: { employeeId },
      select: { step: true, approverId: true },
    })
    const steps = snapshotChain(chain, employeeId)

    const request = await tx.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId,
        status: 'PENDING',
        totalMinutes,
        note,
        submittedAt: now,
        days: { create: dayRows },
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
        action: onBehalf ? 'leaveRequest.override.submit' : 'leaveRequest.submit',
        entityType: 'LeaveRequest',
        entityId: request.id,
        after: { employeeId, leaveTypeId, days, totalMinutes, status: 'PENDING', steps },
        reason: onBehalf?.reason,
      },
      tx,
    )

    const first = await tx.approvalStep.findFirstOrThrow({
      where: { leaveRequestId: request.id, status: 'PENDING' },
      orderBy: { step: 'asc' },
      select: { id: true, approverId: true },
    })
    await notifyStepWaiting({ kind: 'LEAVE', id: request.id }, first, tx)

    return { id: request.id, status: 'PENDING' }
  })
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type DecideArgs = {
  requestId: string
  decision: 'APPROVE' | 'DENY' | 'SKIP'
  /** An approver's optional comment. */
  comment?: string
  /**
   * Set when an administrator acts outside the chain — approving or skipping a
   * step that is not theirs. Required for every override, and recorded on the
   * step and in the audit log.
   */
  overrideReason?: string
}

export type DecideResult = 'ADVANCED' | 'APPROVED' | 'DENIED'

/**
 * Decides the request's current step.
 *
 * On the last approval the balance is checked again — the spec's second
 * check, because a month can pass between submission and the last signature
 * and the time may have been spent elsewhere, or expired. If it no longer
 * covers the request, nothing is written: the step stays pending, and the
 * approver is told to deny it or have the balance corrected. The same goes for
 * a request whose days fall in a benefit year that has closed since it was
 * submitted.
 */
export async function decideLeaveRequest(actor: Actor, args: DecideArgs): Promise<DecideResult> {
  const org = await orgSettingsOrThrow()
  const override = args.overrideReason !== undefined

  if (args.decision === 'SKIP' && !override) {
    throw new RequestError('Only an administrator can skip a step, and only with a reason.')
  }

  return db.$transaction(async (tx) => {
    const request = await lockedRequest(tx, args.requestId)

    if (request.status !== 'PENDING') {
      throw new RequestError('This request has already been decided.')
    }

    const current = currentStep(request.steps)
    if (!current) throw new RequestError('This request has already been decided.')

    if (override) {
      if (!can(actor, 'MANAGE_TIME_RECORDS'))
        throw new RequestError('Only an administrator can override a step.')
      if (actor.id === request.employeeId) {
        throw new RequestError('You cannot override a step on your own request.')
      }
    } else if (!mayDecide(current, actor, request.employeeId)) {
      throw new RequestError(
        actor.id === request.employeeId
          ? 'You cannot decide your own request.'
          : 'This request is not waiting on you.',
      )
    }

    const outcome = applyDecision(request.steps, args.decision)
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
    if (decided.count !== 1) throw new RequestError('This request has already been decided.')

    if (outcome.closed.length > 0) {
      await tx.approvalStep.updateMany({
        where: { id: { in: outcome.closed } },
        data: {
          status: 'SKIPPED',
          decidedAt: now,
          comment: `Not reached: the request was denied at step ${current.step}.`,
        },
      })
    }

    if (outcome.result === 'APPROVED') {
      const today = todayIn(org.timezone)

      // A request submitted in December and approved in January: the year it
      // was for has rolled over without it, so writing its USAGE now would
      // take the time out of the new year's balance instead. Throwing rolls
      // back the step update above.
      refuseClosedYear(
        request.days.map((d) => d.date),
        benefitYearContaining(today, org.benefitYearStartMonth, org.benefitYearStartDay).start,
        'approve',
      )

      const ctx = await loadLeaveContext(
        {
          employeeId: request.employeeId,
          leaveTypeId: request.leaveTypeId,
          today,
          benefitYearStart: benefitYearStart(org),
          excludeRequestId: request.id,
        },
        tx,
      )

      const days: DayInput[] = request.days.map((d) => ({ date: iso(d.date), minutes: d.minutes }))
      const assessment = assess(ctx, days)

      if (assessment.shortfall) {
        // Throwing rolls back the step update above, so the request is left
        // exactly as it was.
        throw new RequestError(
          shortfallMessage(
            request.leaveType.name,
            assessment.shortfall,
            describer(org, ctx.employee.standardMinutesPerDay),
            'approve',
          ),
        )
      }

      await writeEntries(usageEntries(request, request.days), { createdById: actor.id }, tx)
      await tx.leaveRequest.update({
        where: { id: request.id },
        data: { status: 'APPROVED', resolvedAt: now },
      })
    }

    if (outcome.result === 'DENIED') {
      await tx.leaveRequest.update({
        where: { id: request.id },
        data: { status: 'DENIED', resolvedAt: now },
      })
    }

    await writeAudit(
      {
        actorId: actor.id,
        action: `leaveRequest.${override ? 'override.' : ''}${args.decision.toLowerCase()}`,
        entityType: 'LeaveRequest',
        entityId: request.id,
        before: { status: 'PENDING', step: current.step, approverId: current.approverId },
        after: {
          status: outcome.result === 'ADVANCED' ? 'PENDING' : outcome.result,
          step: current.step,
          stepStatus: outcome.decided.status,
          nextStep: outcome.next?.step ?? null,
          comment: args.comment,
        },
        reason: args.overrideReason,
      },
      tx,
    )

    const subject = { kind: 'LEAVE', id: request.id } as const
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

/**
 * Sends the current step to someone else — the approver is away, or has left.
 * Administrator only, with a reason. The step keeps its place in the chain;
 * only who it waits on changes.
 */
export async function rerouteLeaveRequest(
  actor: Actor,
  args: { requestId: string; approverId: string; reason: string },
): Promise<void> {
  if (!can(actor, 'MANAGE_TIME_RECORDS')) throw new RequestError('Only an administrator can reroute a request.')

  await db.$transaction(async (tx) => {
    const request = await lockedRequest(tx, args.requestId)

    if (actor.id === request.employeeId) {
      throw new RequestError('You cannot reroute your own request.')
    }
    if (request.status !== 'PENDING')
      throw new RequestError('This request has already been decided.')

    const current = currentStep(request.steps)
    if (!current) throw new RequestError('This request has already been decided.')

    if (args.approverId === request.employeeId) {
      throw new RequestError('A request cannot be routed to the person who made it.', {
        approverId: ['Choose someone other than the requester.'],
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
        action: 'leaveRequest.override.reroute',
        entityType: 'LeaveRequest',
        entityId: request.id,
        before: { step: current.step, approverId: current.approverId },
        after: { step: current.step, approverId: args.approverId },
        reason: args.reason,
      },
      tx,
    )

    await notifyStepWaiting(
      { kind: 'LEAVE', id: request.id },
      { id: current.id, approverId: args.approverId },
      tx,
      'rerouted',
    )
  })
}

// ---------------------------------------------------------------------------
// Amendment
// ---------------------------------------------------------------------------

/**
 * Changes a pending or approved request's days, amounts or leave type —
 * administrator only, never their own, always with a reason.
 *
 * A pending request keeps its place in the chain; only what it asks for
 * changes. An approved one stays approved: its old days are given back with a
 * `USAGE_REVERSAL` each and the new days are used, so the ledger reads "taken,
 * given back, taken again" rather than an edit (rule 2). The new days are
 * judged against the balance as it would stand without the old ones.
 *
 * Neither old nor new days may sit in a closed benefit year, or on a
 * timesheet already submitted or approved.
 */
export async function amendLeaveRequest(
  actor: Actor,
  args: { requestId: string; values: unknown; reason: string; allowOverdraw: boolean },
): Promise<void> {
  if (!can(actor, 'MANAGE_TIME_RECORDS')) throw new RequestError('Only an administrator can amend a request.')
  const org = await orgSettingsOrThrow()

  const parsed = leaveRequestInput({
    incrementMinutes: org.minimumRequestIncrementMinutes,
    allowSubIncrementWhenBalanceIsLower: org.allowSubIncrementWhenBalanceIsLower,
  }).safeParse(args.values)
  if (!parsed.success) {
    throw new RequestError('Please correct the errors below.', parsed.error.flatten().fieldErrors)
  }

  const { leaveTypeId, note } = parsed.data
  const days = [...parsed.data.days].sort((a, b) => a.date.localeCompare(b.date))
  const today = todayIn(org.timezone)
  const yearStart = benefitYearContaining(
    today,
    org.benefitYearStartMonth,
    org.benefitYearStartDay,
  ).start

  const latest = latestRequestableDate(today)
  if (isoToDate(days[days.length - 1].date) > latest) {
    throw new RequestError(
      `Requests can reach as far ahead as ${iso(latest)}, which is as far as the pay calendar goes.`,
    )
  }
  const newDates = days.map((d) => isoToDate(d.date))
  refuseClosedYear(newDates, yearStart)

  await db.$transaction(async (tx) => {
    const request = await lockedRequest(tx, args.requestId)

    if (actor.id === request.employeeId) {
      throw new RequestError('You cannot amend your own request. Cancel it and request again.')
    }
    if (request.status !== 'PENDING' && request.status !== 'APPROVED') {
      throw new RequestError('Only a pending or approved request can be amended.')
    }
    const oldDates = request.days.map((d) => d.date)
    refuseClosedYear(oldDates, yearStart)
    await refuseLockedTimesheets(tx, request.employeeId, [...oldDates, ...newDates])

    const employee = await tx.employee.findUniqueOrThrow({
      where: { id: request.employeeId },
      select: { standardMinutesPerDay: true, employmentType: true },
    })
    const leaveType = await tx.leaveType.findUnique({
      where: { id: leaveTypeId },
      select: { id: true, name: true, isActive: true, accruableBy: true },
    })
    if (
      !leaveType ||
      !leaveType.isActive ||
      !accruableBy(leaveType.accruableBy, employee.employmentType)
    ) {
      throw new RequestError('That leave type is not available to this employee.', {
        leaveTypeId: ['Choose a leave type from the list.'],
      })
    }

    const describe = describer(org, employee.standardMinutesPerDay)
    const ctx = await loadLeaveContext(
      {
        employeeId: request.employeeId,
        leaveTypeId,
        today,
        benefitYearStart: benefitYearStart(org),
        excludeRequestId: request.id,
      },
      tx,
    )
    // An approved request's own usage is already on the ledger. Judge the new
    // days as if it had been given back, which is what is about to happen.
    const reversals: ProposedEntry[] =
      request.status === 'APPROVED'
        ? request.days.map((day) => ({
            employeeId: request.employeeId,
            leaveTypeId: request.leaveTypeId,
            effectiveDate: day.date,
            minutes: day.minutes,
            kind: 'USAGE_REVERSAL',
            expiresOn: null,
            periodKey: null,
            note: `Amended: ${args.reason}`,
            sourceType: SOURCE_TYPE,
            sourceId: request.id,
          }))
        : []
    if (request.leaveTypeId === leaveTypeId) {
      ctx.ledger = [
        ...ctx.ledger,
        ...reversals.map((r, i) => ({
          id: `~amend-${i}`,
          effectiveDate: r.effectiveDate,
          minutes: r.minutes,
          kind: r.kind,
          expiresOn: null,
        })),
      ]
    }

    const holidays = await tx.holiday.findMany({
      where: { date: { in: newDates } },
      select: { date: true, name: true },
    })
    const booked = await tx.leaveRequestDay.findMany({
      where: {
        date: { in: newDates },
        leaveRequest: {
          employeeId: request.employeeId,
          status: { in: ['PENDING', 'APPROVED'] },
          id: { not: request.id },
        },
      },
      select: { date: true, minutes: true },
    })
    const bookedMinutes = new Map<string, number>()
    for (const day of booked) {
      bookedMinutes.set(iso(day.date), (bookedMinutes.get(iso(day.date)) ?? 0) + day.minutes)
    }

    const assessment = assess(ctx, days)
    const errors = checkDays({
      days,
      incrementMinutes: org.minimumRequestIncrementMinutes,
      allowSubIncrementWhenBalanceIsLower: org.allowSubIncrementWhenBalanceIsLower,
      minutesPerDay: employee.standardMinutesPerDay,
      holidays: new Map(holidays.map((h) => [iso(h.date), h.name])),
      bookedMinutes,
      availableMinutes: assessment.availableMinutes,
      describe,
    })
    if (Object.keys(errors).length > 0) {
      throw new RequestError('Please correct the errors below.', errors)
    }
    if (assessment.shortfall && !args.allowOverdraw) {
      throw new RequestError(
        shortfallMessage(leaveType.name, assessment.shortfall, describe, 'submit'),
      )
    }

    const totalMinutes = days.reduce((sum, d) => sum + d.minutes, 0)
    const dayRows = days.map((d) => ({ date: isoToDate(d.date), minutes: d.minutes }))

    await tx.leaveRequestDay.deleteMany({ where: { leaveRequestId: request.id } })
    await tx.leaveRequest.update({
      where: { id: request.id },
      data: {
        leaveTypeId,
        totalMinutes,
        note: note ?? null,
        days: { create: dayRows },
      },
    })

    if (request.status === 'APPROVED') {
      await writeEntries(reversals, { createdById: actor.id }, tx)
      await writeEntries(
        usageEntries({ id: request.id, employeeId: request.employeeId, leaveTypeId }, dayRows),
        { createdById: actor.id },
        tx,
      )
    }

    await writeAudit(
      {
        actorId: actor.id,
        action: 'leaveRequest.override.amend',
        entityType: 'LeaveRequest',
        entityId: request.id,
        before: {
          status: request.status,
          leaveTypeId: request.leaveTypeId,
          totalMinutes: request.totalMinutes,
          days: request.days.map((d) => ({ date: iso(d.date), minutes: d.minutes })),
        },
        after: {
          status: request.status,
          leaveTypeId,
          totalMinutes,
          days,
          overdrawn: Boolean(assessment.shortfall),
        },
        reason: args.reason,
      },
      tx,
    )
  })
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

/**
 * Cancels a request.
 *
 * The requester may cancel anything pending, and approved leave that has not
 * started yet. An administrator may cancel any pending or approved request,
 * with a reason when it is not their own.
 *
 * Cancelling approved leave writes a `USAGE_REVERSAL` per day and leaves the
 * `USAGE` entries where they are (rule 2), so the history reads "taken, then
 * given back", not a gap. Each reversal is dated on its own day, so the
 * balance on every date reads as if the leave had never been booked — except
 * a day in a benefit year that has already closed. That year's rollover has
 * run on the balance as it stood, and restoring time into it now would carry
 * it past the cap with no forfeit to match (the stale-rollover hazard in
 * docs/ROADMAP.md). Such a day is given back on the first day of the current
 * benefit year instead.
 */
export async function cancelLeaveRequest(
  actor: Actor,
  args: { requestId: string; reason?: string },
): Promise<void> {
  const org = await orgSettingsOrThrow()
  const today = todayIn(org.timezone)

  await db.$transaction(async (tx) => {
    const request = await lockedRequest(tx, args.requestId)
    const own = actor.id === request.employeeId

    if (!own && !can(actor, 'MANAGE_TIME_RECORDS')) {
      throw new RequestError('You can only cancel your own requests.')
    }
    if (!own && !args.reason) {
      throw new RequestError('Say why you are cancelling someone else’s request.', {
        reason: ['A reason is required.'],
      })
    }

    if (request.status !== 'PENDING' && request.status !== 'APPROVED') {
      throw new RequestError('Only a pending or approved request can be cancelled.')
    }

    if (request.status === 'APPROVED' && !(can(actor, 'MANAGE_TIME_RECORDS') && !own)) {
      const started = request.days.some((d) => d.date <= today)
      if (started) {
        throw new RequestError(
          'This leave has already started, so it cannot be cancelled here. Ask an administrator.',
        )
      }
    }

    const now = new Date()

    if (request.status === 'APPROVED') {
      const yearStart = benefitYearContaining(
        today,
        org.benefitYearStartMonth,
        org.benefitYearStartDay,
      ).start

      const reversals: ProposedEntry[] = request.days.map((day) => ({
        employeeId: request.employeeId,
        leaveTypeId: request.leaveTypeId,
        effectiveDate: maxDate(day.date, yearStart),
        minutes: day.minutes,
        kind: 'USAGE_REVERSAL',
        expiresOn: null,
        periodKey: null,
        note:
          day.date < yearStart
            ? `Cancelled; ${iso(day.date)} was in a closed benefit year, so it is restored here`
            : 'Cancelled',
        sourceType: SOURCE_TYPE,
        sourceId: request.id,
      }))
      await writeEntries(reversals, { createdById: actor.id }, tx)
    }

    await tx.approvalStep.updateMany({
      where: { leaveRequestId: request.id, status: 'PENDING' },
      data: {
        status: 'SKIPPED',
        decidedAt: now,
        comment: 'Not reached: the request was cancelled.',
      },
    })

    await tx.leaveRequest.update({
      where: { id: request.id },
      data: { status: 'CANCELLED', resolvedAt: now },
    })

    await writeAudit(
      {
        actorId: actor.id,
        action: 'leaveRequest.cancel',
        entityType: 'LeaveRequest',
        entityId: request.id,
        before: { status: request.status },
        after: {
          status: 'CANCELLED',
          reversedMinutes: request.status === 'APPROVED' ? request.totalMinutes : 0,
        },
        reason: args.reason,
      },
      tx,
    )
  })
}

/**
 * Locks the requester and then the request — the one order every operation
 * uses, so two of them can never deadlock — and reads it fresh.
 */
async function lockedRequest(tx: Tx, requestId: string) {
  const head = await tx.leaveRequest.findUnique({
    where: { id: requestId },
    select: { employeeId: true },
  })
  if (!head) throw new RequestError('That request no longer exists.')

  await lockEmployee(tx, head.employeeId)
  await lockRequest(tx, requestId)

  // Three queries rather than one with two relations: Prisma loads sibling
  // relations concurrently, and inside a transaction that means overlapping
  // queries on a single connection, which node-postgres is deprecating.
  const request = await tx.leaveRequest.findUniqueOrThrow({
    where: { id: requestId },
    select: {
      id: true,
      employeeId: true,
      leaveTypeId: true,
      status: true,
      totalMinutes: true,
      leaveType: { select: { name: true } },
    },
  })
  const days = await tx.leaveRequestDay.findMany({
    where: { leaveRequestId: requestId },
    select: { date: true, minutes: true },
    orderBy: { date: 'asc' },
  })
  const steps = await tx.approvalStep.findMany({
    where: { leaveRequestId: requestId },
    select: { id: true, step: true, approverId: true, status: true },
    orderBy: { step: 'asc' },
  })

  return { ...request, days, steps }
}
