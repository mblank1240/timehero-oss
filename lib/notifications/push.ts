/**
 * Web Push, through the `web-push` library: VAPID-signed, payload encrypted
 * for each browser's keys.
 *
 * A browser's subscription is an endpoint at its vendor's push service plus
 * two keys. The service answers 404 or 410 once the subscription has gone —
 * the person cleared their site data, or revoked permission — and the row is
 * deleted so nothing is sent there again.
 */

import webpush, { WebPushError } from 'web-push'

import { env, isPushConfigured } from '@/lib/env'

export type PushTarget = { endpoint: string; p256dh: string; auth: string }

export type PushPayload = { title: string; body: string; url: string; tag: string }

export type PushResult = 'SENT' | 'GONE' | 'FAILED'

let configured = false

function configure() {
  if (configured) return
  webpush.setVapidDetails(env.VAPID_SUBJECT!, env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!)
  configured = true
}

/**
 * How long a push service holds a message for a browser that is offline. A
 * notification older than this is still in the in-app list.
 */
const TTL_SECONDS = 24 * 60 * 60

export async function sendPush(
  target: PushTarget,
  payload: PushPayload,
): Promise<{ result: PushResult; error?: string }> {
  if (!isPushConfigured) return { result: 'FAILED', error: 'Web Push is not configured.' }
  configure()

  try {
    await webpush.sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      JSON.stringify(payload),
      { TTL: TTL_SECONDS, urgency: 'normal' },
    )
    return { result: 'SENT' }
  } catch (error) {
    if (error instanceof WebPushError && (error.statusCode === 404 || error.statusCode === 410)) {
      return { result: 'GONE' }
    }
    return {
      result: 'FAILED',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
