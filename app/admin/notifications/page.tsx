import { Checkbox, ConfigForm, Field, SubmitButton } from '@/components/form'
import { db } from '@/lib/db'
import { env, isPushConfigured } from '@/lib/env'
import { mailTransport } from '@/lib/mail'
import { updateNotificationSettings } from '@/lib/notifications/actions'
import { NOTIFICATION_LABELS, NOTIFICATION_TYPES } from '@/lib/notifications/channels'
import { orgSettingsOrThrow } from '@/lib/ledger/policies'

export const metadata = { title: 'Notifications · Administration · TimeHero' }

/**
 * How the organization notifies people: the address email comes from (none,
 * no email), which notifications exist at all, and how insistently things
 * left waiting on an approver are chased.
 */
export default async function NotificationSettingsPage() {
  const [org, subscribed, failed] = await Promise.all([
    orgSettingsOrThrow(),
    db.pushSubscription.groupBy({ by: ['employeeId'] }).then((rows) => rows.length),
    db.notification.count({ where: { OR: [{ pushStatus: 'FAILED' }, { emailStatus: 'FAILED' }] } }),
  ])
  const transport = mailTransport()

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Notifications</h1>
        <p className="mt-1 text-sm text-muted">
          Everyone gets notifications in TimeHero&apos;s own list, and by push in any browser they
          turn it on in. Email is added only when you give an address to send from.
        </p>
      </div>

      <ul className="th-card divide-y divide-border text-sm">
        <li className="flex justify-between gap-3 p-3">
          <span>Push</span>
          <span className="text-muted">
            {isPushConfigured
              ? `On — ${subscribed} ${subscribed === 1 ? 'person has' : 'people have'} subscribed a browser`
              : 'Off: the server has no VAPID keys (VAPID_* in the environment)'}
          </span>
        </li>
        <li className="flex justify-between gap-3 p-3">
          <span>Email</span>
          <span className="text-muted">
            {!transport
              ? 'Off: the server has no outgoing mail (MAIL_TRANSPORT)'
              : org.mailFromAddress
                ? `On — from ${org.mailFromAddress}, through ${transport}`
                : 'Off: no sending address set below'}
          </span>
        </li>
        <li className="flex justify-between gap-3 p-3">
          <span>Emailed sign-in links</span>
          <span className="text-muted">
            {!env.AUTH_EMAIL_LINKS
              ? 'Off for this deployment (AUTH_EMAIL_LINKS)'
              : transport && org.mailFromAddress
                ? 'Offered on the sign-in page'
                : 'Not offered until email is on'}
          </span>
        </li>
        {failed > 0 && (
          <li className="flex justify-between gap-3 p-3">
            <span>Undelivered</span>
            <span className="text-danger">
              {failed} notification{failed === 1 ? '' : 's'} could not be delivered after repeated
              tries — see the send-notifications runs under Jobs
            </span>
          </li>
        )}
      </ul>

      <ConfigForm action={updateNotificationSettings} successMessage="Settings saved.">
        <Field
          label="Send email from"
          name="mailFromAddress"
          hint={
            transport === 'graph'
              ? 'A mailbox in your Microsoft 365 tenant that the TimeHero app may send as (docs/ENTRA-SETUP.md). Leave blank to send no email.'
              : 'An address your mail server will send as. Leave blank to send no email at all.'
          }
        >
          <input
            id="mailFromAddress"
            name="mailFromAddress"
            type="email"
            defaultValue={org.mailFromAddress ?? ''}
            placeholder="time@example.org"
            className="th-input"
          />
        </Field>

        <fieldset className="space-y-3 rounded-lg border border-border p-4">
          <legend className="px-1 text-sm font-semibold">Notifications sent</legend>
          <p className="text-xs text-muted">
            A notification switched off here is not sent to anyone, by any channel. Each person
            chooses push and email for the rest on their own Notifications page.
          </p>
          {NOTIFICATION_TYPES.map((type) => (
            <Checkbox
              key={type}
              name={`type_${type}`}
              label={NOTIFICATION_LABELS[type].label}
              hint={NOTIFICATION_LABELS[type].description}
              defaultChecked={org.notificationTypesEnabled.includes(type)}
            />
          ))}
        </fieldset>

        <fieldset className="space-y-4 rounded-lg border border-border p-4">
          <legend className="px-1 text-sm font-semibold">Chasing approvals</legend>
          <p className="text-xs text-muted">
            An approver is told once when something arrives. If it is still waiting after the
            first number of days, they are reminded at the first interval; after a further number
            of days, at the second.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Start reminding after (days)" name="approvalReminderAfterDays">
              <input
                id="approvalReminderAfterDays"
                name="approvalReminderAfterDays"
                type="number"
                min={0}
                max={365}
                required
                defaultValue={org.approvalReminderAfterDays}
                className="th-input"
              />
            </Field>
            <Field label="Then every (hours)" name="approvalReminderIntervalHours">
              <input
                id="approvalReminderIntervalHours"
                name="approvalReminderIntervalHours"
                type="number"
                min={1}
                max={720}
                required
                defaultValue={org.approvalReminderIntervalHours}
                className="th-input"
              />
            </Field>
            <Field label="Escalate after a further (days)" name="approvalEscalateAfterDays">
              <input
                id="approvalEscalateAfterDays"
                name="approvalEscalateAfterDays"
                type="number"
                min={0}
                max={365}
                required
                defaultValue={org.approvalEscalateAfterDays}
                className="th-input"
              />
            </Field>
            <Field label="Then every (hours)" name="approvalEscalateIntervalHours">
              <input
                id="approvalEscalateIntervalHours"
                name="approvalEscalateIntervalHours"
                type="number"
                min={1}
                max={720}
                required
                defaultValue={org.approvalEscalateIntervalHours}
                className="th-input"
              />
            </Field>
          </div>
          <Field
            label="Daily digest hour"
            name="approverDigestHour"
            hint={`0–23, in ${org.timezone}. Approvers who choose a digest get one email a day at this hour instead of one per item.`}
          >
            <input
              id="approverDigestHour"
              name="approverDigestHour"
              type="number"
              min={0}
              max={23}
              required
              defaultValue={org.approverDigestHour}
              className="th-input"
            />
          </Field>
        </fieldset>

        <Field
          label="Remind about timesheets (days before the period ends)"
          name="timesheetReminderDaysBeforePeriodEnd"
          hint="Hourly staff with a timesheet not yet submitted are reminded from this many days before the period's last day. Overdue reminders follow the due date set under Settings."
        >
          <input
            id="timesheetReminderDaysBeforePeriodEnd"
            name="timesheetReminderDaysBeforePeriodEnd"
            type="number"
            min={0}
            max={31}
            required
            defaultValue={org.timesheetReminderDaysBeforePeriodEnd}
            className="th-input"
          />
        </Field>

        <SubmitButton label="Save settings" />
      </ConfigForm>
    </div>
  )
}
