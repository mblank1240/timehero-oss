'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { ForbiddenError, getCurrentUser } from '@/lib/authz'
import type { ActionResult } from '@/lib/employees/actions'
import { deliverSoon } from '@/lib/notifications/after'
import type { Actor } from '@/lib/requests/chain'

import {
  overtimeCancelInput,
  overtimeDecisionInput,
  overtimeOverrideInput,
  overtimeRerouteInput,
} from './schema'
import {
  RequestError,
  cancelOvertimeLog,
  decideOvertimeLog,
  rerouteOvertimeLog,
  submitOvertimeLog,
} from './service'

/** The actor is whoever the session says, re-read from the database (rule 8). */
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

function revalidateOvertime(logId?: string) {
  deliverSoon()
  revalidatePath('/')
  revalidatePath('/overtime')
  revalidatePath('/approvals')
  revalidatePath('/admin/requests')
  revalidatePath('/admin/ledger')
  if (logId) revalidatePath(`/overtime/${logId}`)
}

function parse<T extends z.ZodType>(schema: T, formData: FormData): z.infer<T> {
  const parsed = schema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    const fieldErrors = z.flattenError(parsed.error).fieldErrors as Record<string, string[]>
    throw new RequestError('Please correct the errors below.', fieldErrors)
  }
  return parsed.data
}

export async function submitOvertime(
  _previousState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let id: string
  try {
    const actor = await currentActor()
    ;({ id } = await submitOvertimeLog(actor, Object.fromEntries(formData)))
    revalidateOvertime()
  } catch (error) {
    return handle(error)
  }
  redirect(`/overtime/${id}`)
}

function decide(decision: 'APPROVE' | 'DENY') {
  return async (formData: FormData): Promise<ActionResult> => {
    try {
      const actor = await currentActor()
      const { logId, comment } = parse(overtimeDecisionInput, formData)
      await decideOvertimeLog(actor, { logId, decision, comment })
      revalidateOvertime(logId)
      return { ok: true }
    } catch (error) {
      return handle(error)
    }
  }
}

export async function approveOvertime(_previousState: ActionResult | null, formData: FormData) {
  return decide('APPROVE')(formData)
}

export async function denyOvertime(_previousState: ActionResult | null, formData: FormData) {
  return decide('DENY')(formData)
}

function override(decision: 'APPROVE' | 'SKIP') {
  return async (formData: FormData): Promise<ActionResult> => {
    try {
      const actor = await currentActor()
      const { logId, reason } = parse(overtimeOverrideInput, formData)
      await decideOvertimeLog(actor, { logId, decision, overrideReason: reason })
      revalidateOvertime(logId)
      return { ok: true }
    } catch (error) {
      return handle(error)
    }
  }
}

export async function overrideApproveOvertime(
  _previousState: ActionResult | null,
  formData: FormData,
) {
  return override('APPROVE')(formData)
}

export async function overrideSkipOvertimeStep(
  _previousState: ActionResult | null,
  formData: FormData,
) {
  return override('SKIP')(formData)
}

export async function rerouteOvertime(
  _previousState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const actor = await currentActor()
    const input = parse(overtimeRerouteInput, formData)
    await rerouteOvertimeLog(actor, input)
    revalidateOvertime(input.logId)
    return { ok: true }
  } catch (error) {
    return handle(error)
  }
}

export async function cancelOvertime(
  _previousState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const actor = await currentActor()
    const input = parse(overtimeCancelInput, formData)
    await cancelOvertimeLog(actor, input)
    revalidateOvertime(input.logId)
    return { ok: true }
  } catch (error) {
    return handle(error)
  }
}
