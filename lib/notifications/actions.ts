'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { z } from 'zod'

import { diff, writeAudit } from '@/lib/audit'
import { ForbiddenError, getCurrentUser, requirePermissionOrThrow } from '@/lib/authz'
import { db } from '@/lib/db'
import type { ActionResult } from '@/lib/employees/actions'

import { sendPush } from './push'
import { notificationSettingsInput, preferencesInput, pushSubscriptionInput } from './schema'

export type { ActionResult }

function fail(error: string, fieldErrors?: Record<string, string[]>): ActionResult {
  return { ok: false, error, fieldErrors }
}

function handle(error: unknown): ActionResult {
  if (error instanceof ForbiddenError) return fail(error.message)
  console.error(error)
  return fail('Something went wrong. Please try again.')
}

/** Whoever the session says, re-read from the database (rule 8). */
async function me() {
  const user = await getCurrentUser()
  if (!user) throw new ForbiddenError('Not signed in')
  return user
}

// ---------------------------------------------------------------------------
// The organization's settings
// ---------------------------------------------------------------------------

export async function updateNotificationSettings(
  _previousState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const actor = await requirePermissionOrThrow('MANAGE_SETTINGS')

    const parsed = notificationSettingsInput.safeParse(Object.fromEntries(formData))
    if (!parsed.success) {
      const fieldErrors = z.flattenError(parsed.error).fieldErrors as Record<string, string[]>
      return fail('Please correct the errors below.', fieldErrors)
    }

    const before = await db.orgSettings.findUniqueOrThrow({ where: { id: 1 } })
    const after = await db.orgSettings.update({ where: { id: 1 }, data: parsed.data })

    const changed = diff(
      before as unknown as Record<string, unknown>,
      after as unknown as Record<string, unknown>,
    )
    if (Object.keys(changed.after).length > 0) {
      await writeAudit({
        actorId: actor.id,
        action: 'orgSettings.notifications.update',
        entityType: 'OrgSettings',
        entityId: '1',
        before: changed.before,
        after: changed.after,
      })
    }

    revalidatePath('/admin/notifications')
    revalidatePath('/notifications')
    revalidatePath('/signin')
    return { ok: true }
  } catch (error) {
    return handle(error)
  }
}

// ---------------------------------------------------------------------------
// One employee's own choices
// ---------------------------------------------------------------------------

export async function savePreferences(
  _previousState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await me()
    const parsed = preferencesInput.safeParse(Object.fromEntries(formData))
    if (!parsed.success) return fail('Those choices could not be saved.')

    await db.$transaction(async (tx) => {
      for (const p of parsed.data.preferences) {
        await tx.notificationPreference.upsert({
          where: { employeeId_type: { employeeId: user.id, type: p.type } },
          update: { push: p.push, email: p.email },
          create: { employeeId: user.id, type: p.type, push: p.push, email: p.email },
        })
      }
      await tx.employee.update({
        where: { id: user.id },
        data: { approvalDigest: parsed.data.approvalDigest },
      })
    })

    revalidatePath('/notifications')
    return { ok: true }
  } catch (error) {
    return handle(error)
  }
}

/** Browsers one employee may have subscribed at once. */
const MAX_PUSH_SUBSCRIPTIONS_PER_EMPLOYEE = 10

/** Records this browser's push subscription for the signed-in employee. */
export async function subscribePush(input: unknown): Promise<ActionResult> {
  try {
    const user = await me()
    const parsed = pushSubscriptionInput.safeParse(input)
    if (!parsed.success) return fail('The browser gave an unusable subscription.')

    const userAgent = (await headers()).get('user-agent')?.slice(0, 300) ?? null
    const { endpoint, keys } = parsed.data

    // An endpoint belongs to one browser profile. If someone else signed in
    // on it before, it now pushes to whoever subscribed last.
    await db.pushSubscription.upsert({
      where: { endpoint },
      update: { employeeId: user.id, p256dh: keys.p256dh, auth: keys.auth, userAgent },
      create: { employeeId: user.id, endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent },
    })

    // Every subscription is a send on every notification. Past the cap, the
    // oldest go — most likely browsers long since cleared or replaced.
    const stale = await db.pushSubscription.findMany({
      where: { employeeId: user.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: MAX_PUSH_SUBSCRIPTIONS_PER_EMPLOYEE,
      select: { id: true },
    })
    if (stale.length > 0) {
      await db.pushSubscription.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } })
    }

    revalidatePath('/notifications')
    return { ok: true }
  } catch (error) {
    return handle(error)
  }
}

export async function unsubscribePush(endpoint: unknown): Promise<ActionResult> {
  try {
    const user = await me()
    if (typeof endpoint !== 'string') return fail('No subscription given.')
    await db.pushSubscription.deleteMany({ where: { endpoint, employeeId: user.id } })
    revalidatePath('/notifications')
    return { ok: true }
  } catch (error) {
    return handle(error)
  }
}

/** Pushes a test message to every browser the employee has subscribed. */
export async function sendTestPush(): Promise<ActionResult> {
  try {
    const user = await me()
    const targets = await db.pushSubscription.findMany({ where: { employeeId: user.id } })
    if (targets.length === 0) return fail('No browser is subscribed yet.')

    let sent = 0
    for (const target of targets) {
      const { result } = await sendPush(target, {
        title: 'TimeHero test',
        body: 'Push notifications are working on this device.',
        url: '/notifications',
        tag: `test-${Date.now()}`,
      })
      if (result === 'SENT') sent += 1
      if (result === 'GONE') await db.pushSubscription.deleteMany({ where: { id: target.id } })
    }

    revalidatePath('/notifications')
    return sent > 0 ? { ok: true } : fail('The push service did not accept the message.')
  } catch (error) {
    return handle(error)
  }
}

// ---------------------------------------------------------------------------
// The in-app list
// ---------------------------------------------------------------------------

/** Marks one of the employee's own notifications read, or all of them. */
export async function markRead(formData: FormData): Promise<void> {
  const user = await me()
  const id = formData.get('id')
  await db.notification.updateMany({
    where: {
      recipientId: user.id,
      readAt: null,
      ...(typeof id === 'string' && id ? { id } : {}),
    },
    data: { readAt: new Date() },
  })
  revalidatePath('/notifications')
  revalidatePath('/', 'layout')
}
