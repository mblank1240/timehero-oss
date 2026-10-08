import { z } from 'zod'

/**
 * Validation for manual ledger adjustments.
 *
 * An adjustment is the only way a human writes to the ledger directly, and it
 * exists because the alternative — editing a row — is forbidden (rule 2 in
 * CLAUDE.md). Importing opening balances, correcting a mis-keyed request,
 * granting a one-off award: all of them are an `ADJUSTMENT` entry.
 *
 * Deliberately *not* validated against `minimumRequestIncrementMinutes`. That
 * rule constrains what an employee may request; an adjustment is a correction
 * and has to be able to say 137 minutes, because that is what the old system
 * said someone had.
 */

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker (YYYY-MM-DD).')
  .transform((s) => new Date(`${s}T00:00:00.000Z`))

/** A year of minutes either way — beyond that it is a typo, not a correction. */
const MAX_ADJUSTMENT_MINUTES = 60 * 24 * 366

export const adjustmentInput = z.object({
  employeeId: z.string().min(1, 'Choose an employee.'),
  leaveTypeId: z.string().min(1, 'Choose a leave type.'),
  effectiveDate: dateString,

  minutes: z.coerce
    .number()
    .int('Enter a whole number of minutes.')
    .refine((v) => v !== 0, 'An adjustment of zero would change nothing.')
    .refine(
      (v) => Math.abs(v) <= MAX_ADJUSTMENT_MINUTES,
      'That is implausibly large for a single adjustment.',
    ),

  /**
   * Required, and stored on the entry itself rather than only in the audit
   * log. An adjustment with no reason is unexplainable the moment its author
   * forgets why — and the author is usually the only person who knew.
   */
  reason: z
    .string()
    .trim()
    .min(5, 'Say why this adjustment is being made.')
    .max(500, 'Keep the reason under 500 characters.'),
})

export type AdjustmentInput = z.infer<typeof adjustmentInput>
