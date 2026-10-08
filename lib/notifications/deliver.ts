/**
 * Delivering notifications by push and email.
 *
 * Runs after the transaction that created them has committed — straight
 * after the action that caused them, and again from the hourly
 * `send-notifications` job, which picks up anything that failed or was never
 * tried. Each channel of each row is claimed (`PENDING` → `SENDING`) by a
 * conditional update before it is sent, so two deliveries running at once
 * cannot both send it. A claim left behind by a crash is released after a
 * while and tried again: a duplicate is better than a notification lost.
 */

import { appUrl } from '@/lib/env'
import { db } from '@/lib/db'
import { sendMail } from '@/lib/mail'

import { sendPush } from './push'

/** Tries per notification before it is marked failed. */
const MAX_ATTEMPTS = 5
const STALE_CLAIM_MS = 10 * 60 * 1000
const BATCH = 200

export type DeliveryCounts = { pushed: number; emailed: number; failed: number }

export async function deliverNotifications(now: Date = new Date()): Promise<DeliveryCounts> {
  const stale = new Date(now.getTime() - STALE_CLAIM_MS)
  await db.notification.updateMany({
    where: { pushStatus: 'SENDING', updatedAt: { lt: stale } },
    data: { pushStatus: 'PENDING' },
  })
  await db.notification.updateMany({
    where: { emailStatus: 'SENDING', updatedAt: { lt: stale } },
    data: { emailStatus: 'PENDING' },
  })

  const due = await db.notification.findMany({
    where: { OR: [{ pushStatus: 'PENDING' }, { emailStatus: 'PENDING' }] },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
    select: {
      id: true,
      title: true,
      body: true,
      url: true,
      attempts: true,
      pushStatus: true,
      emailStatus: true,
      recipient: { select: { id: true, email: true, firstName: true } },
    },
  })

  const counts: DeliveryCounts = { pushed: 0, emailed: 0, failed: 0 }

  for (const n of due) {
    if (n.pushStatus === 'PENDING') {
      const outcome = await deliverPush(n)
      if (outcome === 'SENT') counts.pushed += 1
      if (outcome === 'FAILED') counts.failed += 1
    }
    if (n.emailStatus === 'PENDING') {
      const outcome = await deliverEmail(n)
      if (outcome === 'SENT') counts.emailed += 1
      if (outcome === 'FAILED') counts.failed += 1
    }
  }

  return counts
}

type Due = {
  id: string
  title: string
  body: string
  url: string
  attempts: number
  recipient: { id: string; email: string; firstName: string }
}

async function claim(id: string, channel: 'pushStatus' | 'emailStatus'): Promise<boolean> {
  const claimed = await db.notification.updateMany({
    where: { id, [channel]: 'PENDING' },
    data: { [channel]: 'SENDING' },
  })
  return claimed.count === 1
}

/** A failed try: back to PENDING for the next run, or FAILED for good. */
async function failed(n: Due, channel: 'pushStatus' | 'emailStatus', error: string) {
  const attempts = n.attempts + 1
  n.attempts = attempts
  await db.notification.update({
    where: { id: n.id },
    data: {
      [channel]: attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING',
      attempts,
      lastError: error.slice(0, 1000),
    },
  })
}

async function deliverPush(n: Due): Promise<'SENT' | 'FAILED' | 'NONE' | 'RETRY'> {
  if (!(await claim(n.id, 'pushStatus'))) return 'NONE'

  const targets = await db.pushSubscription.findMany({
    where: { employeeId: n.recipient.id },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  })

  // Nowhere to push to — every browser has unsubscribed since. The in-app
  // list still has it; there is nothing to retry.
  if (targets.length === 0) {
    await db.notification.update({ where: { id: n.id }, data: { pushStatus: null } })
    return 'NONE'
  }

  const payload = { title: n.title, body: n.body, url: n.url, tag: n.id }
  let sent = 0
  let gone = 0
  const errors: string[] = []

  for (const target of targets) {
    const { result, error } = await sendPush(target, payload)
    if (result === 'SENT') {
      sent += 1
      await db.pushSubscription.update({
        where: { id: target.id },
        data: { lastSuccessAt: new Date() },
      })
    } else if (result === 'GONE') {
      gone += 1
      await db.pushSubscription.deleteMany({ where: { id: target.id } })
    } else if (error) {
      errors.push(error)
    }
  }

  if (sent > 0) {
    await db.notification.update({ where: { id: n.id }, data: { pushStatus: 'SENT' } })
    return 'SENT'
  }
  if (gone === targets.length) {
    await db.notification.update({ where: { id: n.id }, data: { pushStatus: null } })
    return 'NONE'
  }

  await failed(n, 'pushStatus', errors.join('; ') || 'Push failed.')
  return n.attempts >= MAX_ATTEMPTS ? 'FAILED' : 'RETRY'
}

async function deliverEmail(n: Due): Promise<'SENT' | 'FAILED' | 'NONE' | 'RETRY'> {
  if (!(await claim(n.id, 'emailStatus'))) return 'NONE'

  try {
    await sendMail({
      to: n.recipient.email,
      subject: n.title,
      text: emailText(n.recipient.firstName, n.body, n.url),
    })
  } catch (error) {
    await failed(n, 'emailStatus', error instanceof Error ? error.message : String(error))
    return n.attempts >= MAX_ATTEMPTS ? 'FAILED' : 'RETRY'
  }

  await db.notification.update({ where: { id: n.id }, data: { emailStatus: 'SENT' } })
  return 'SENT'
}

export function emailText(firstName: string, body: string, url: string): string {
  return [
    `Hi ${firstName},`,
    '',
    body,
    '',
    `Open it in TimeHero: ${appUrl()}${url}`,
    '',
    '—',
    `You can choose which notifications you get, and how: ${appUrl()}/notifications`,
  ].join('\n')
}
