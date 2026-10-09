import Link from 'next/link'

import { ConfigForm, SubmitButton } from '@/components/form'
import { PushToggle } from '@/components/push-toggle'
import { requireUser } from '@/lib/authz'
import { db } from '@/lib/db'
import { env } from '@/lib/env'
import { markRead, savePreferences } from '@/lib/notifications/actions'
import { DEFAULT_PREFERENCE, NOTIFICATION_LABELS, NOTIFICATION_TYPES } from '@/lib/notifications/channels'
import { availableChannels, recentNotifications } from '@/lib/notifications/queries'
import { orgSettingsOrThrow } from '@/lib/ledger/policies'
import { canAny } from '@/lib/permissions'
import { formatTimestamp } from '@/lib/requests/format'

export const metadata = { title: 'Notifications · TimeHero' }

/**
 * Everything TimeHero has told this person, newest first, and how they want
 * to be told: push in each browser they turn it on in, and email when the
 * organization sends it.
 */
export default async function NotificationsPage() {
  const user = await requireUser()
  const [org, channels, items, prefs, me, browsers] = await Promise.all([
    orgSettingsOrThrow(),
    availableChannels(),
    recentNotifications(user.id),
    db.notificationPreference.findMany({ where: { employeeId: user.id } }),
    db.employee.findUniqueOrThrow({ where: { id: user.id }, select: { approvalDigest: true } }),
    db.pushSubscription.findMany({
      where: { employeeId: user.id },
      select: { id: true, userAgent: true, createdAt: true, lastSuccessAt: true },
      orderBy: { createdAt: 'asc' },
    }),
  ])

  const preference = new Map(prefs.map((p) => [p.type, { push: p.push, email: p.email }]))
  const unread = items.filter((n) => !n.readAt).length

  // Types this person is shown a choice for. The others still carry their
  // current values as hidden fields, so saving the form cannot quietly
  // switch off a channel that is simply not on offer right now.
  const visible = NOTIFICATION_TYPES.filter(
    (t) =>
      channels.enabledTypes.includes(t) &&
      (!NOTIFICATION_LABELS[t].forPermissions ||
        canAny(user, NOTIFICATION_LABELS[t].forPermissions)),
  )

  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <section className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Notifications</h1>
            <p className="mt-1 text-sm text-muted">
              {unread === 0 ? 'Nothing unread.' : `${unread} unread.`}
            </p>
          </div>
          {unread > 0 && (
            <form action={markRead}>
              <button type="submit" className="th-btn-secondary">
                Mark all read
              </button>
            </form>
          )}
        </div>

        {items.length === 0 ? (
          <p className="th-card p-4 text-sm text-muted">No notifications yet.</p>
        ) : (
          <ul className="th-card divide-y divide-border" aria-label="Notifications">
            {items.map((n) => (
              <li key={n.id} className="flex items-start gap-3 p-4">
                <span
                  aria-hidden
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.readAt ? 'bg-transparent' : 'bg-accent'}`}
                />
                <div className="min-w-0 flex-1">
                  <Link href={n.url} className="font-medium underline-offset-2 hover:underline">
                    {n.title}
                  </Link>
                  <p className="text-sm">{n.body}</p>
                  <p className="mt-1 text-xs text-muted">
                    {formatTimestamp(n.createdAt, org.timezone)}
                    {!n.readAt && <span className="sr-only"> · unread</span>}
                  </p>
                </div>
                {!n.readAt && (
                  <form action={markRead}>
                    <input type="hidden" name="id" value={n.id} />
                    <button type="submit" className="text-xs text-muted hover:text-foreground">
                      Mark read
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Push notifications</h2>
        {channels.push && env.VAPID_PUBLIC_KEY ? (
          <>
            <p className="text-sm text-muted">
              Turn them on in each browser and on each phone where you want them.
            </p>
            <PushToggle publicKey={env.VAPID_PUBLIC_KEY} />
            {browsers.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer text-muted">
                  {browsers.length === 1
                    ? '1 browser receives your notifications'
                    : `${browsers.length} browsers receive your notifications`}
                </summary>
                <ul className="mt-2 space-y-1 break-words text-xs text-muted">
                  {browsers.map((b) => (
                    <li key={b.id}>
                      {b.userAgent ?? 'Unknown browser'} — since{' '}
                      {formatTimestamp(b.createdAt, org.timezone)}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        ) : (
          <p className="text-sm text-muted">
            Push notifications are not set up on this server yet. Everything still appears in the
            list above.
          </p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">What you get</h2>
        <p className="text-sm text-muted">
          Everything appears in the list above.{' '}
          {channels.email
            ? `Choose which also come by push, and which by email from ${channels.mailFromAddress}.`
            : 'Choose which also come by push. Your organization does not send email.'}
        </p>

        <ConfigForm action={savePreferences} successMessage="Saved.">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th className="py-2 font-normal">Notification</th>
                <th className="w-16 py-2 text-center font-normal">Push</th>
                {channels.email && <th className="w-16 py-2 text-center font-normal">Email</th>}
              </tr>
            </thead>
            <tbody>
              {visible.map((type) => {
                const p = preference.get(type) ?? DEFAULT_PREFERENCE
                return (
                  <tr key={type} className="border-b border-border">
                    <td className="py-2 pr-2">
                      <div className="font-medium">{NOTIFICATION_LABELS[type].label}</div>
                      <div className="text-xs text-muted">
                        {NOTIFICATION_LABELS[type].description}
                      </div>
                    </td>
                    <td className="py-2 text-center">
                      <input
                        type="checkbox"
                        name={`push_${type}`}
                        value="true"
                        defaultChecked={p.push}
                        aria-label={`${NOTIFICATION_LABELS[type].label} by push`}
                        className="h-4 w-4"
                      />
                    </td>
                    {channels.email && (
                      <td className="py-2 text-center">
                        <input
                          type="checkbox"
                          name={`email_${type}`}
                          value="true"
                          defaultChecked={p.email}
                          aria-label={`${NOTIFICATION_LABELS[type].label} by email`}
                          className="h-4 w-4"
                        />
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>

          {NOTIFICATION_TYPES.map((type) => {
            const p = preference.get(type) ?? DEFAULT_PREFERENCE
            const shown = visible.includes(type)
            return (
              <span key={type} hidden>
                {!shown && p.push && <input type="hidden" name={`push_${type}`} value="true" />}
                {(!shown || !channels.email) && p.email && (
                  <input type="hidden" name={`email_${type}`} value="true" />
                )}
              </span>
            )
          })}

          {channels.email && visible.includes('APPROVAL_WAITING') ? (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                name="approvalDigest"
                value="true"
                defaultChecked={me.approvalDigest}
                className="mt-0.5 h-4 w-4"
              />
              <span>
                Email me about things waiting on me once a day, as a digest, instead of one email
                each
                <span className="block text-xs text-muted">
                  Sent at {String(org.approverDigestHour).padStart(2, '0')}:00. Push and this list
                  still tell you about each one as it arrives.
                </span>
              </span>
            </label>
          ) : (
            me.approvalDigest && <input type="hidden" name="approvalDigest" value="true" />
          )}

          <SubmitButton label="Save" />
        </ConfigForm>
      </section>
    </div>
  )
}
