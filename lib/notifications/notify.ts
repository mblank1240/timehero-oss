/**
 * Creating notifications.
 *
 * Called inside the transaction that makes the change being announced, so a
 * decision that rolls back announces nothing. Each row records which channels
 * it is owed — push, email, or the approver's digest — and is delivered
 * after the transaction commits (`deliver.ts`).
 *
 * The unique `(recipientId, key)` makes a repeat a no-op: a sweep that runs
 * twice, or a service retried, creates nothing the second time (rule 3).
 */

import type { NotificationType, Prisma, PrismaClient } from '@prisma/client'

import { db } from '@/lib/db'
import { isPushConfigured } from '@/lib/env'
import { mailTransport } from '@/lib/mail'

import { channelsFor, type Preference } from './channels'

type Client = PrismaClient | Prisma.TransactionClient

export type NotificationDraft = {
  recipientId: string
  type: NotificationType
  key: string
  title: string
  body: string
  /** A path within the app. */
  url: string
}

/** Creates what is not already there. Returns how many rows were written. */
export async function createNotifications(
  drafts: readonly NotificationDraft[],
  client: Client = db,
): Promise<number> {
  if (drafts.length === 0) return 0

  // One query at a time: inside a transaction this is a single connection.
  const org = await client.orgSettings.findUniqueOrThrow({
    where: { id: 1 },
    select: { notificationTypesEnabled: true, mailFromAddress: true },
  })
  const emailAvailable = Boolean(org.mailFromAddress && mailTransport())

  const recipientIds = [...new Set(drafts.map((d) => d.recipientId))]
  const recipients = await client.employee.findMany({
    where: { id: { in: recipientIds }, isActive: true },
    select: { id: true, approvalDigest: true },
  })
  const prefs = await client.notificationPreference.findMany({
    where: { employeeId: { in: recipientIds } },
    select: { employeeId: true, type: true, push: true, email: true },
  })

  // Push is owed only where there is a browser to push to.
  const subscribed = isPushConfigured
    ? new Set(
        (
          await client.pushSubscription.findMany({
            where: { employeeId: { in: recipientIds } },
            select: { employeeId: true },
            distinct: ['employeeId'],
          })
        ).map((s) => s.employeeId),
      )
    : new Set<string>()

  const digest = new Map(recipients.map((r) => [r.id, r.approvalDigest]))
  const preference = new Map<string, Preference>(
    prefs.map((p) => [`${p.employeeId}:${p.type}`, { push: p.push, email: p.email }]),
  )

  const rows: Prisma.NotificationCreateManyInput[] = []
  for (const draft of drafts) {
    // Someone who has left gets nothing, not even a list entry.
    if (!digest.has(draft.recipientId)) continue

    const channels = channelsFor({
      type: draft.type,
      enabledTypes: org.notificationTypesEnabled,
      emailAvailable,
      pushAvailable: subscribed.has(draft.recipientId),
      preference: preference.get(`${draft.recipientId}:${draft.type}`),
      approvalDigest: digest.get(draft.recipientId) ?? false,
    })
    if (!channels) continue

    rows.push({
      ...draft,
      pushStatus: channels.push ? 'PENDING' : null,
      emailStatus:
        channels.email === 'SEND' ? 'PENDING' : channels.email === 'DIGEST' ? 'DIGEST' : null,
    })
  }

  if (rows.length === 0) return 0
  const result = await client.notification.createMany({ data: rows, skipDuplicates: true })
  return result.count
}
