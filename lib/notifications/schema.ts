import { z } from 'zod'

import { NOTIFICATION_TYPES } from './channels'

/**
 * Validation for the notification settings: the organization's (an
 * administrator's) and each employee's own.
 */

const checked = (raw: Record<string, unknown>, name: string) =>
  raw[name] === 'true' || raw[name] === 'on'

/** Checkboxes named `type_<TYPE>`, folded into the list the column holds. */
function collectTypes(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || 'notificationTypesEnabled' in raw) return raw
  const r = raw as Record<string, unknown>
  return {
    ...r,
    notificationTypesEnabled: NOTIFICATION_TYPES.filter((t) => checked(r, `type_${t}`)),
  }
}

const wholeNumber = (label: string, min: number, max: number) =>
  z.coerce
    .number()
    .int(`${label} must be a whole number.`)
    .min(min, `${label} must be at least ${min}.`)
    .max(max, `${label} can be at most ${max}.`)

export const notificationSettingsInput = z.preprocess(
  collectTypes,
  z.object({
    /** Blank sends no email at all. */
    mailFromAddress: z
      .string()
      .trim()
      .toLowerCase()
      .optional()
      .transform((v) => (v ? v : null))
      .pipe(z.union([z.null(), z.email('Enter an email address, or leave it blank.')])),
    notificationTypesEnabled: z.array(z.enum(NOTIFICATION_TYPES)),
    approvalReminderAfterDays: wholeNumber('Days before reminders', 0, 365),
    approvalReminderIntervalHours: wholeNumber('Hours between reminders', 1, 24 * 30),
    approvalEscalateAfterDays: wholeNumber('Further days before escalating', 0, 365),
    approvalEscalateIntervalHours: wholeNumber('Hours between escalated reminders', 1, 24 * 30),
    timesheetReminderDaysBeforePeriodEnd: wholeNumber('Days before the period ends', 0, 31),
    approverDigestHour: wholeNumber('Digest hour', 0, 23),
  }),
)

/**
 * One employee's choices: `push_<TYPE>` and `email_<TYPE>` checkboxes for
 * every type, and whether approval email comes as a daily digest.
 */
function collectPreferences(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || 'preferences' in raw) return raw
  const r = raw as Record<string, unknown>
  return {
    approvalDigest: r.approvalDigest,
    preferences: NOTIFICATION_TYPES.map((type) => ({
      type,
      push: checked(r, `push_${type}`),
      email: checked(r, `email_${type}`),
    })),
  }
}

export const preferencesInput = z.preprocess(
  collectPreferences,
  z.object({
    approvalDigest: z
      .union([z.literal('true'), z.literal('on')])
      .optional()
      .transform((v) => v !== undefined),
    preferences: z.array(
      z.object({ type: z.enum(NOTIFICATION_TYPES), push: z.boolean(), email: z.boolean() }),
    ),
  }),
)

/** What `PushManager.subscribe()` hands the browser, as `toJSON()` shapes it. */
export const pushSubscriptionInput = z.object({
  endpoint: z
    .url()
    .max(2048)
    .refine((u) => u.startsWith('https://'), 'A push endpoint is always https.'),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
  }),
})
