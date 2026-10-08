'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { ForbiddenError, getCurrentUser } from '@/lib/authz'
import type { ActionResult } from '@/lib/employees/actions'
import { deliverSoon } from '@/lib/notifications/after'
import type { Actor } from '@/lib/requests/chain'

import {
  timesheetDecisionInput,
  timesheetOverrideInput,
  timesheetRerouteInput,
  timesheetSaveInput,
  timesheetUnlockInput,
  timesheetWithdrawInput,
} from './schema'
import {
  RequestError,
  decideTimesheet,
  rerouteTimesheet,
  saveTimesheet,
  unlockTimesheet,
  withdrawTimesheet,
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

function revalidateTimesheet(timesheetId: string) {
  deliverSoon()
  revalidatePath('/timesheets')
  revalidatePath(`/timesheets/${timesheetId}`)
  revalidatePath('/approvals')
  revalidatePath('/admin/timesheets')
}

function parse<T extends z.ZodType>(schema: T, formData: FormData): z.infer<T> {
  const parsed = schema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    const fieldErrors = z.flattenError(parsed.error).fieldErrors as Record<string, string[]>
    throw new RequestError('Please correct the errors below.', fieldErrors)
  }
  return parsed.data
}

export async function saveTimesheetGrid(
  _previousState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const actor = await currentActor()
    const { timesheetId, intent, reason } = parse(timesheetSaveInput, formData)
    await saveTimesheet(actor, {
      timesheetId,
      reason,
      values: Object.fromEntries(formData),
      submit: intent === 'submit',
    })
    revalidateTimesheet(timesheetId)
    return { ok: true }
  } catch (error) {
    return handle(error)
  }
}

export async function withdrawTimesheetAction(
  _previousState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const actor = await currentActor()
    const { timesheetId } = parse(timesheetWithdrawInput, formData)
    await withdrawTimesheet(actor, { timesheetId })
    revalidateTimesheet(timesheetId)
    return { ok: true }
  } catch (error) {
    return handle(error)
  }
}

function decide(decision: 'APPROVE' | 'DENY') {
  return async (formData: FormData): Promise<ActionResult> => {
    try {
      const actor = await currentActor()
      const { timesheetId, comment } = parse(timesheetDecisionInput, formData)
      await decideTimesheet(actor, { timesheetId, decision, comment })
      revalidateTimesheet(timesheetId)
      return { ok: true }
    } catch (error) {
      return handle(error)
    }
  }
}

export async function approveTimesheet(_previousState: ActionResult | null, formData: FormData) {
  return decide('APPROVE')(formData)
}

export async function rejectTimesheet(_previousState: ActionResult | null, formData: FormData) {
  return decide('DENY')(formData)
}

function override(decision: 'APPROVE' | 'SKIP') {
  return async (formData: FormData): Promise<ActionResult> => {
    try {
      const actor = await currentActor()
      const { timesheetId, reason } = parse(timesheetOverrideInput, formData)
      await decideTimesheet(actor, { timesheetId, decision, overrideReason: reason })
      revalidateTimesheet(timesheetId)
      return { ok: true }
    } catch (error) {
      return handle(error)
    }
  }
}

export async function overrideApproveTimesheet(
  _previousState: ActionResult | null,
  formData: FormData,
) {
  return override('APPROVE')(formData)
}

export async function overrideSkipTimesheetStep(
  _previousState: ActionResult | null,
  formData: FormData,
) {
  return override('SKIP')(formData)
}

export async function rerouteTimesheetAction(
  _previousState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const actor = await currentActor()
    const input = parse(timesheetRerouteInput, formData)
    await rerouteTimesheet(actor, input)
    revalidateTimesheet(input.timesheetId)
    return { ok: true }
  } catch (error) {
    return handle(error)
  }
}

export async function unlockTimesheetAction(
  _previousState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const actor = await currentActor()
    const input = parse(timesheetUnlockInput, formData)
    await unlockTimesheet(actor, input)
    revalidateTimesheet(input.timesheetId)
    return { ok: true }
  } catch (error) {
    return handle(error)
  }
}
