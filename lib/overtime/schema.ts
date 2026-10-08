import { z } from 'zod'

import { isValidIncrement, parseDuration } from '@/lib/duration'

/**
 * Validation for overtime logs.
 *
 * Overtime is time actually worked, so it is measured in the *timesheet*
 * increment (15 minutes at the church's settings), not the leave increment —
 * docs/SPEC.md "Comp time". The increment is data (rule 1), so the schema is
 * built from it rather than fixed.
 *
 * Decisions on a log reuse the leave request's decision, override and reroute
 * schemas, under a `logId` instead of a `requestId`.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** A real calendar date, so `2026-02-30` is refused rather than read as 2 March. */
function isRealDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** A sanity bound, not a policy: nobody works more than a day in a day. */
export const MAX_OVERTIME_MINUTES = 24 * 60

export type OvertimeRules = {
  incrementMinutes: number
  /** What "1d" means when someone types it. */
  minutesPerDay: number
}

export function overtimeLogInput(rules: OvertimeRules) {
  return z.object({
    date: z.string().refine(isRealDate, 'Enter the date you worked.'),
    worked: z
      .string()
      .trim()
      .min(1, 'Enter how long you worked.')
      .transform((value, ctx) => {
        const minutes = parseDuration(value, { minutesPerDay: rules.minutesPerDay })
        if (minutes === null) {
          ctx.addIssue({ code: 'custom', message: 'Enter a time such as 2h 15m, or 2:15.' })
          return z.NEVER
        }
        return minutes
      })
      .refine((m) => m > 0, 'Enter how long you worked.')
      .refine((m) => m <= MAX_OVERTIME_MINUTES, 'That is more than a day.')
      .refine(
        (m) => isValidIncrement(m, rules.incrementMinutes),
        `Record time worked in steps of ${rules.incrementMinutes} minutes.`,
      ),
    note: z
      .string()
      .trim()
      .min(1, 'Say what the time was for.')
      .max(500, 'Keep the note under 500 characters.'),
  })
}

export type OvertimeLogInput = z.infer<ReturnType<typeof overtimeLogInput>>

const comment = z
  .string()
  .trim()
  .max(500, 'Keep the comment under 500 characters.')
  .optional()
  .transform((v) => (v ? v : undefined))

const reason = z
  .string()
  .trim()
  .min(5, 'Say why.')
  .max(500, 'Keep the reason under 500 characters.')

const logId = z.string().min(1)

export const overtimeDecisionInput = z.object({ logId, comment })

export const overtimeCancelInput = z.object({
  logId,
  /** Required when an administrator cancels someone else's log. */
  reason: comment,
})

export const overtimeOverrideInput = z.object({ logId, reason })

export const overtimeRerouteInput = z.object({
  logId,
  approverId: z.string().min(1, 'Choose who it should go to.'),
  reason,
})
