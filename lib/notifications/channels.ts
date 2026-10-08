/**
 * Which notifications exist, and which channels one goes out on.
 *
 * Pure. Every notification lands in the in-app list; push and email are
 * extra, decided here from three layers: what the organization has switched
 * on, whether it sends email at all, and what the recipient chose.
 */

import type { NotificationType } from '@prisma/client'

export const NOTIFICATION_TYPES = [
  'APPROVAL_WAITING',
  'REQUEST_DECIDED',
  'TIMESHEET_DUE',
  'TIMESHEET_OVERDUE',
  'ROLLOVER_SUMMARY',
] as const satisfies readonly NotificationType[]

export const NOTIFICATION_LABELS: Record<
  NotificationType,
  { label: string; description: string; adminOnly?: boolean }
> = {
  APPROVAL_WAITING: {
    label: 'Waiting on you',
    description:
      'A request, overtime log or timesheet needs your approval — when it arrives, and reminders while it waits.',
  },
  REQUEST_DECIDED: {
    label: 'Decisions',
    description: 'Your request, overtime log or timesheet was approved, denied or sent back.',
  },
  TIMESHEET_DUE: {
    label: 'Timesheet due',
    description: 'Your timesheet for the pay period is due soon.',
  },
  TIMESHEET_OVERDUE: {
    label: 'Timesheet overdue',
    description: 'Your timesheet is past its due date and not yet submitted.',
  },
  ROLLOVER_SUMMARY: {
    label: 'Year-end rollover',
    description: 'What the benefit-year rollover forfeited and carried.',
    adminOnly: true,
  },
}

export type Preference = { push: boolean; email: boolean }

/** No preference row: push on, and email on whenever the org sends it. */
export const DEFAULT_PREFERENCE: Preference = { push: true, email: true }

export type Channels = {
  push: boolean
  /** `DIGEST`: wanted, but held for the recipient's daily digest. */
  email: 'SEND' | 'DIGEST' | null
}

/**
 * The channels for one notification to one person, or null when the type is
 * switched off for the organization — then nothing is created at all.
 */
export function channelsFor(args: {
  type: NotificationType
  enabledTypes: readonly NotificationType[]
  /** The org has a sending address and a transport to use it. */
  emailAvailable: boolean
  pushAvailable: boolean
  preference: Preference | undefined
  /** The recipient takes one digest a day instead of approval emails. */
  approvalDigest: boolean
}): Channels | null {
  if (!args.enabledTypes.includes(args.type)) return null

  const preference = args.preference ?? DEFAULT_PREFERENCE
  const push = args.pushAvailable && preference.push

  let email: Channels['email'] = null
  if (args.emailAvailable && preference.email) {
    email = args.type === 'APPROVAL_WAITING' && args.approvalDigest ? 'DIGEST' : 'SEND'
  }

  return { push, email }
}
