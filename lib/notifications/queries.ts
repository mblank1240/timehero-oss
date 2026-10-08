/** Reads behind the notifications page and the header's count. */

import { db } from '@/lib/db'
import { isPushConfigured } from '@/lib/env'
import { mailTransport } from '@/lib/mail'

export async function unreadCount(employeeId: string): Promise<number> {
  return db.notification.count({ where: { recipientId: employeeId, readAt: null } })
}

/** How many of the most recent notifications the page lists. A display choice. */
export const LIST_LENGTH = 50

export async function recentNotifications(employeeId: string) {
  return db.notification.findMany({
    where: { recipientId: employeeId },
    orderBy: { createdAt: 'desc' },
    take: LIST_LENGTH,
    select: {
      id: true,
      type: true,
      title: true,
      body: true,
      url: true,
      readAt: true,
      createdAt: true,
      pushStatus: true,
      emailStatus: true,
    },
  })
}

/** What this deployment and organization can send, beyond the in-app list. */
export async function availableChannels() {
  const org = await db.orgSettings.findUniqueOrThrow({
    where: { id: 1 },
    select: { mailFromAddress: true, notificationTypesEnabled: true },
  })
  return {
    push: isPushConfigured,
    email: Boolean(org.mailFromAddress && mailTransport()),
    mailFromAddress: org.mailFromAddress,
    enabledTypes: org.notificationTypesEnabled,
  }
}
