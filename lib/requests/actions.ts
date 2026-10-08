'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { benefitYearContaining, todayIn } from '@/lib/accrual/dates'
import { ForbiddenError, getCurrentUser } from '@/lib/authz'
import { db } from '@/lib/db'
import type { ActionResult } from '@/lib/employees/actions'
import { accruableBy, orgSettingsOrThrow } from '@/lib/ledger/policies'
import { deliverSoon } from '@/lib/notifications/after'

import type { Actor } from './chain'
import { assess, isoToDate, loadLeaveContext } from './context'
import {
  MAX_REQUEST_DAYS,
  amendInput,
  cancelInput,
  decisionInput,
  onBehalfInput,
  overrideInput,
  requestFormValues,
  rerouteInput,
} from './schema'
import {
  RequestError,
  amendLeaveRequest,
  cancelLeaveRequest,
  decideLeaveRequest,
  latestRequestableDate,
  rerouteLeaveRequest,
  submitLeaveRequest,
} from './service'

export type { ActionResult }

/**
 * The actor is whoever the session says, re-read from the database (rule 8).
 * Nothing a form posts can name a different employee.
 */
async function currentActor(): Promise<Actor> {
  const user = await getCurrentUser()
  if (!user) throw new ForbiddenError('Not signed in')
  return { id: user.id, role: user.role }
}

function fail(error: string, fieldErrors?: Record<string, string[]>): ActionResult {
  return { ok: false, error, fieldErrors }
}

function handle(error: unknown): ActionResult {
  if (error instanceof RequestError) return fail(error.message, error.fieldErrors)
  if (error instanceof ForbiddenError) return fail(error.message)
  console.error(error)
  return fail('Something went wrong. Please try again.')
}

function revalidateRequests(requestId?: string) {
  deliverSoon()
  revalidatePath('/requests')
  revalidatePath('/approvals')
  revalidatePath('/admin/requests')
  revalidatePath('/admin/ledger')
  if (requestId) revalidatePath(`/requests/${requestId}`)
}

export async function submitRequest(
  _previousState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let id: string
  try {
    const actor = await currentActor()
    ;({ id } = await submitLeaveRequest(actor, requestFormValues(formData)))
    revalidateRequests()
  } catch (error) {
    return handle(error)
  }
  // `redirect` throws a control-flow signal, so it runs outside the try.
  redirect(`/requests/${id}`)
}

/**
 * An administrator entering leave for someone else: through their approval
 * chain, or recorded as already approved. The employee comes from the form,
 * which is why the service insists the actor is an administrator.
 */
export async function recordLeave(
  _previousState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let id: string
  try {
    const actor = await currentActor()
    const onBehalf = parse(onBehalfInput, formData)
    ;({ id } = await submitLeaveRequest(actor, requestFormValues(formData), onBehalf))
    revalidateRequests()
  } catch (error) {
    return handle(error)
  }
  redirect(`/requests/${id}`)
}

/** An administrator changing a pending or approved request's days or type. */
export async function amendRequest(
  _previousState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let requestId: string
  try {
    const actor = await currentActor()
    const input = parse(amendInput, formData)
    requestId = input.requestId
    await amendLeaveRequest(actor, { ...input, values: requestFormValues(formData) })
    revalidateRequests(requestId)
  } catch (error) {
    return handle(error)
  }
  redirect(`/requests/${requestId}`)
}

function parse<T extends z.ZodType>(schema: T, formData: FormData): z.infer<T> {
  const parsed = schema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    // Every key is a form field and every value a list of messages; the
    // generic schema just hides that from the compiler.
    const fieldErrors = z.flattenError(parsed.error).fieldErrors as Record<string, string[]>
    throw new RequestError('Please correct the errors below.', fieldErrors)
  }
  return parsed.data
}

function decide(decision: 'APPROVE' | 'DENY') {
  return async (formData: FormData): Promise<ActionResult> => {
    try {
      const actor = await currentActor()
      const { requestId, comment } = parse(decisionInput, formData)
      await decideLeaveRequest(actor, { requestId, decision, comment })
      revalidateRequests(requestId)
      return { ok: true }
    } catch (error) {
      return handle(error)
    }
  }
}

export async function approveRequest(_previousState: ActionResult | null, formData: FormData) {
  return decide('APPROVE')(formData)
}

export async function denyRequest(_previousState: ActionResult | null, formData: FormData) {
  return decide('DENY')(formData)
}

function override(decision: 'APPROVE' | 'DENY' | 'SKIP') {
  return async (formData: FormData): Promise<ActionResult> => {
    try {
      const actor = await currentActor()
      const { requestId, reason } = parse(overrideInput, formData)
      await decideLeaveRequest(actor, { requestId, decision, overrideReason: reason })
      revalidateRequests(requestId)
      return { ok: true }
    } catch (error) {
      return handle(error)
    }
  }
}

export async function overrideApproveRequest(
  _previousState: ActionResult | null,
  formData: FormData,
) {
  return override('APPROVE')(formData)
}

export async function overrideDenyRequest(
  _previousState: ActionResult | null,
  formData: FormData,
) {
  return override('DENY')(formData)
}

export async function overrideSkipStep(_previousState: ActionResult | null, formData: FormData) {
  return override('SKIP')(formData)
}

export async function rerouteRequest(
  _previousState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const actor = await currentActor()
    const input = parse(rerouteInput, formData)
    await rerouteLeaveRequest(actor, input)
    revalidateRequests(input.requestId)
    return { ok: true }
  } catch (error) {
    return handle(error)
  }
}

export async function cancelRequest(
  _previousState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const actor = await currentActor()
    const input = parse(cancelInput, formData)
    await cancelLeaveRequest(actor, input)
    revalidateRequests(input.requestId)
    return { ok: true }
  } catch (error) {
    return handle(error)
  }
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

const previewInput = z.object({
  leaveTypeId: z.string().min(1),
  /** An administrator previewing for someone else. Ignored for anyone else. */
  employeeId: z.string().optional(),
  /** The request being amended, whose own days must not count against it. */
  requestId: z.string().optional(),
  days: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        minutes: z.number().int().min(0),
      }),
    )
    .max(MAX_REQUEST_DAYS),
})

/**
 * The dates a preview may ask about. Submission refuses the same range
 * (`latestRequestableDate` and `refuseClosedYear` in ./service), so nothing
 * the form could actually send is turned away here.
 */
function previewWindow(
  today: Date,
  org: { benefitYearStartMonth: number; benefitYearStartDay: number },
): { earliest: Date; latest: Date } {
  return {
    earliest: benefitYearContaining(today, org.benefitYearStartMonth, org.benefitYearStartDay)
      .start,
    latest: latestRequestableDate(today),
  }
}

/** Every day a real calendar date (no 2026-02-31) inside the window. */
function daysWithin(
  days: readonly { date: string }[],
  window: { earliest: Date; latest: Date },
): boolean {
  return days.every((d) => {
    const date = isoToDate(d.date)
    return (
      !Number.isNaN(date.getTime()) &&
      date.toISOString().slice(0, 10) === d.date &&
      date >= window.earliest &&
      date <= window.latest
    )
  })
}

export type RequestPreview =
  | {
      ok: true
      availableMinutes: number
      balanceAfterMinutes: number
      pendingMinutes: number
      shortfall: { date: string; balanceMinutes: number } | null
    }
  | { ok: false }

/**
 * The projected balance the request form shows as days are chosen.
 *
 * A read, not a mutation — but it has to run the projection on the server,
 * where the ledger is, and re-render on every change of the picker, which a
 * server component cannot do. It writes nothing, and it is advisory only: the
 * submission runs the same assessment again inside its transaction.
 */
export async function previewRequest(input: unknown): Promise<RequestPreview> {
  try {
    const actor = await currentActor()
    const parsed = previewInput.safeParse(input)
    if (!parsed.success) return { ok: false }

    const days = parsed.data.days.filter((d) => d.minutes > 0)
    if (days.length === 0) return { ok: false }

    // Rule 8: only an administrator may look at someone else's balance.
    const employeeId =
      actor.role === 'ADMIN' && parsed.data.employeeId ? parsed.data.employeeId : actor.id

    const [org, employee, leaveType] = await Promise.all([
      orgSettingsOrThrow(),
      db.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { employmentType: true } }),
      db.leaveType.findUnique({
        where: { id: parsed.data.leaveTypeId },
        select: { isActive: true, accruableBy: true },
      }),
    ])
    if (!leaveType?.isActive || !accruableBy(leaveType.accruableBy, employee.employmentType)) {
      return { ok: false }
    }

    // The projection runs day by day out to the last date asked about, so an
    // unbounded date (9999-12-31) would hold the event loop for minutes. The
    // same window submission enforces: no earlier than the open benefit year,
    // no later than the generated pay calendar.
    const today = todayIn(org.timezone)
    if (!daysWithin(days, previewWindow(today, org))) return { ok: false }

    const amending =
      actor.role === 'ADMIN' && parsed.data.requestId
        ? await db.leaveRequest.findFirst({
            where: { id: parsed.data.requestId, employeeId },
            select: {
              id: true,
              status: true,
              leaveTypeId: true,
              days: { select: { date: true, minutes: true } },
            },
          })
        : null

    const ctx = await loadLeaveContext({
      employeeId,
      leaveTypeId: parsed.data.leaveTypeId,
      today,
      benefitYearStart: { month: org.benefitYearStartMonth, day: org.benefitYearStartDay },
      excludeRequestId: amending?.id,
    })
    // An approved request being amended: its usage is about to be given back.
    if (amending?.status === 'APPROVED' && amending.leaveTypeId === parsed.data.leaveTypeId) {
      ctx.ledger = [
        ...ctx.ledger,
        ...amending.days.map((d, i) => ({
          id: `~amend-${i}`,
          effectiveDate: d.date,
          minutes: d.minutes,
          kind: 'USAGE_REVERSAL' as const,
          expiresOn: null,
        })),
      ]
    }
    const result = assess(ctx, days)

    return {
      ok: true,
      availableMinutes: result.availableMinutes,
      balanceAfterMinutes: result.balanceAfterMinutes,
      pendingMinutes: result.pendingMinutes,
      shortfall: result.shortfall && {
        date: result.shortfall.date.toISOString().slice(0, 10),
        balanceMinutes: result.shortfall.balanceMinutes,
      },
    }
  } catch (error) {
    console.error(error)
    return { ok: false }
  }
}
