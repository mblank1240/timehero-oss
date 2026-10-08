import { z } from 'zod'

import { isValidIncrement, parseDuration } from '@/lib/duration'

/**
 * Validation for timesheets.
 *
 * The grid posts one `worked-YYYY-MM-DD` and one `note-YYYY-MM-DD` field per
 * day of the period. Worked time is measured in the *timesheet* increment, not
 * the leave increment — hours actually worked are not a half-day concept, and
 * forcing them into four-hour blocks would make payroll wrong (docs/SPEC.md).
 * The increment is data (rule 1), so the schema is built from it.
 *
 * The schema is built from the period's dates as well, so a field for a day
 * outside the period is never read, and a day the employee was not employed
 * has no field to read.
 */

/** A sanity bound, not a policy: nobody works more than a day in a day. */
export const MAX_DAY_MINUTES = 24 * 60

export type GridRules = {
  incrementMinutes: number
  /** What "1d" means when someone types it. */
  minutesPerDay: number
}

export const workedField = (iso: string) => `worked-${iso}`
export const noteField = (iso: string) => `note-${iso}`

export function workedTime(rules: GridRules) {
  return z
    .string()
    .trim()
    .optional()
    .transform((value, ctx) => {
      if (!value) return 0
      const minutes = parseDuration(value, { minutesPerDay: rules.minutesPerDay })
      if (minutes === null) {
        ctx.addIssue({ code: 'custom', message: 'Enter a time such as 7h 30m, or 7:30.' })
        return z.NEVER
      }
      return minutes
    })
    .refine((m) => m >= 0, 'Time worked cannot be negative.')
    .refine((m) => m <= MAX_DAY_MINUTES, 'That is more than a day.')
    .refine(
      (m) => m === 0 || isValidIncrement(m, rules.incrementMinutes),
      `Record time worked in steps of ${rules.incrementMinutes} minutes.`,
    )
}

const dayNote = z
  .string()
  .trim()
  .max(200, 'Keep the note under 200 characters.')
  .optional()
  .transform((v) => (v ? v : null))

/** The grid for the days that can be edited, keyed by ISO date. */
export function timesheetGridInput(rules: GridRules, editableDays: readonly string[]) {
  const shape: Record<string, z.ZodType> = {}
  for (const iso of editableDays) {
    shape[workedField(iso)] = workedTime(rules)
    shape[noteField(iso)] = dayNote
  }
  return z
    .object(shape)
    .superRefine((values, ctx) => {
      // A note lives on the day's worked row, and a day with nothing worked
      // has no row — so refuse rather than drop it silently.
      for (const iso of editableDays) {
        if (values[noteField(iso)] && values[workedField(iso)] === 0) {
          ctx.addIssue({
            code: 'custom',
            path: [noteField(iso)],
            message: 'A note needs time worked on the same day.',
          })
        }
      }
    })
    .transform((values) =>
    editableDays.map((iso) => ({
      date: iso,
      minutes: values[workedField(iso)] as number,
      note: values[noteField(iso)] as string | null,
    })),
  )
}

export type GridDayInput = { date: string; minutes: number; note: string | null }

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

const timesheetId = z.string().min(1)

export const timesheetSaveInput = z.object({
  timesheetId,
  /** Which button was pressed: save the grid, or save it and submit. */
  intent: z.enum(['save', 'submit']).default('save'),
  /** Required when an administrator fills in someone else's timesheet. */
  reason: z
    .string()
    .trim()
    .max(500, 'Keep the reason under 500 characters.')
    .optional()
    .transform((v) => (v ? v : undefined)),
})

export const timesheetDecisionInput = z.object({ timesheetId, comment })

export const timesheetWithdrawInput = z.object({ timesheetId })

export const timesheetOverrideInput = z.object({ timesheetId, reason })

export const timesheetUnlockInput = z.object({ timesheetId, reason })

export const timesheetRerouteInput = z.object({
  timesheetId,
  approverId: z.string().min(1, 'Choose who it should go to.'),
  reason,
})
