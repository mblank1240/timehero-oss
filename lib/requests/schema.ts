import { z } from 'zod'

import { isValidIncrement } from '@/lib/duration'

/**
 * Validation for leave requests and the decisions made on them.
 *
 * The request schema is built from the org's increment rather than fixed,
 * because the increment is data (rule 1): an administrator changing it from
 * 240 to 480 invalidates half-day submissions on the next request, with no
 * deploy and without touching a request already made.
 *
 * This is the first of rule 6's two checks. It knows nothing about balances,
 * so it lets through a single sub-increment day that the stranded-balance
 * exception *might* cover; the service layer (`./validate.ts`) decides whether
 * it does.
 */

/** A sanity bound on one request, not a policy: a year of days is a typo. */
export const MAX_REQUEST_DAYS = 366

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** A real calendar date, so `2026-02-30` is refused rather than read as 2 March. */
function isRealDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export type IncrementRules = {
  incrementMinutes: number
  allowSubIncrementWhenBalanceIsLower: boolean
}

const dayInput = z.object({
  date: z.string().refine(isRealDate, 'Not a real date.'),
  minutes: z.coerce.number().int('Choose an amount from the list.').min(0),
})

export function leaveRequestInput(rules: IncrementRules) {
  return z
    .object({
      leaveTypeId: z.string().min(1, 'Choose a leave type.'),
      note: z
        .string()
        .trim()
        .max(500, 'Keep the note under 500 characters.')
        .optional()
        .transform((v) => (v ? v : undefined)),
      days: z
        .array(dayInput)
        .max(MAX_REQUEST_DAYS, 'That is more days than one request can cover.')
        // A day set to "none" is a day in the range the employee is not
        // taking, not a zero-minute request.
        .transform((days) => days.filter((d) => d.minutes > 0))
        .refine((days) => days.length > 0, 'Choose at least one day.')
        .refine(
          (days) => new Set(days.map((d) => d.date)).size === days.length,
          'A date appears twice.',
        ),
    })
    .superRefine((value, ctx) => {
      const single = value.days.length === 1
      for (const day of value.days) {
        if (isValidIncrement(day.minutes, rules.incrementMinutes)) continue

        // Only a lone day below one increment can be the stranded remainder;
        // whether it really equals the balance is the service layer's call.
        const mightBeRemainder =
          single &&
          rules.allowSubIncrementWhenBalanceIsLower &&
          day.minutes < rules.incrementMinutes

        if (!mightBeRemainder) {
          ctx.addIssue({
            code: 'custom',
            path: [`day.${day.date}`],
            message: `Each day must be a multiple of ${rules.incrementMinutes} minutes.`,
          })
        }
      }
    })
}

export type LeaveRequestInput = z.infer<ReturnType<typeof leaveRequestInput>>

/**
 * The request form posts one field per day, `day.2026-10-12 = 480`, so it
 * still submits without JavaScript. This folds them into the schema's shape.
 */
export function requestFormValues(formData: FormData) {
  const days: { date: string; minutes: string }[] = []
  for (const [key, value] of formData.entries()) {
    if (key.startsWith('day.') && typeof value === 'string') {
      days.push({ date: key.slice(4), minutes: value })
    }
  }

  return {
    leaveTypeId: formData.get('leaveTypeId'),
    note: formData.get('note') ?? undefined,
    days,
  }
}

const comment = z
  .string()
  .trim()
  .max(500, 'Keep the comment under 500 characters.')
  .optional()
  .transform((v) => (v ? v : undefined))

/**
 * Required wherever an administrator steps outside the chain (rule 9, and the
 * spec's "each action audit-logged with a required reason").
 */
const reason = z
  .string()
  .trim()
  .min(5, 'Say why.')
  .max(500, 'Keep the reason under 500 characters.')

const requestId = z.string().min(1)

export const decisionInput = z.object({ requestId, comment })

export const cancelInput = z.object({
  requestId,
  /** Required when an administrator cancels someone else's request. */
  reason: comment,
})

export const overrideInput = z.object({ requestId, reason })

export const rerouteInput = z.object({
  requestId,
  approverId: z.string().min(1, 'Choose who it should go to.'),
  reason,
})

/** An unchecked checkbox is absent from FormData entirely. */
const checkbox = z
  .union([z.literal('on'), z.literal('true')])
  .optional()
  .transform((v) => v !== undefined)

/** The administrator's half of "record leave for someone". */
export const onBehalfInput = z.object({
  employeeId: z.string().min(1),
  reason,
  approveNow: checkbox,
  allowOverdraw: checkbox,
})

/** The administrator's half of amending a request. */
export const amendInput = z.object({
  requestId,
  reason,
  allowOverdraw: checkbox,
})
