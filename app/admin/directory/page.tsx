import Link from 'next/link'

import { ActionButton, ConfigForm, Field, SubmitButton } from '@/components/form'
import { db } from '@/lib/db'
import {
  disconnectDirectory,
  registerGoogleWorkspace,
  setAutoProvision,
  syncDirectoryNow,
} from '@/lib/directory/actions'
import { isEntraConfigured, isGoogleConfigured } from '@/lib/env'
import { orgSettingsOrThrow } from '@/lib/ledger/policies'
import { formatTimestamp } from '@/lib/requests/format'
import { emailLinksAvailable } from '@/lib/sign-in-links'

export const metadata = { title: 'Directory · TimeHero' }

/**
 * Sign-in methods and the organization's directory. Registering the
 * Microsoft tenant imports its active staff and lets anyone from it sign in
 * and be linked by email; Google Workspace domains do the linking for
 * Google sign-in.
 */
export default async function DirectoryPage({ searchParams }: PageProps<'/admin/directory'>) {
  const params = await searchParams
  const emailLinks = await emailLinksAvailable()
  const [org, connections, review] = await Promise.all([
    orgSettingsOrThrow(),
    db.directoryConnection.findMany({
      include: { connectedBy: { select: { firstName: true, lastName: true } } },
    }),
    db.employee.findMany({
      where: { needsReview: true },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: { id: true, firstName: true, lastName: true, email: true },
    }),
  ])
  const microsoft = connections.find((c) => c.provider === 'MICROSOFT')
  const google = connections.find((c) => c.provider === 'GOOGLE')

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Sign-in and directory</h1>
        <p className="mt-1 text-sm text-muted">
          How people sign in, and the organization&apos;s own directory of staff.
        </p>
      </div>

      {typeof params.error === 'string' && (
        <p role="alert" className="th-error">
          {params.error}
        </p>
      )}
      {params.connected === 'microsoft' && (
        <p role="status" className="th-card p-3 text-sm">
          Microsoft 365 is connected. Active staff were imported — review them below.
        </p>
      )}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Sign-in methods</h2>
        <ul className="th-card divide-y divide-border text-sm">
          <Method
            name="Microsoft"
            on={isEntraConfigured}
            how="AUTH_MICROSOFT_ENTRA_ID_* in the environment"
          />
          <Method
            name="Google"
            on={isGoogleConfigured}
            how="AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET"
          />
          <Method
            name="Emailed link"
            on={emailLinks}
            how="AUTH_EMAIL_LINKS=true, outgoing mail, and a sending address under Notifications"
          />
        </ul>
        <p className="text-xs text-muted">
          Sign-in methods are part of the deployment&apos;s configuration, not a setting here. See
          docs/AUTH-PLAN.md.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Microsoft 365</h2>
        {microsoft ? (
          <div className="th-card space-y-3 p-4 text-sm">
            <p>
              Connected to tenant <span className="font-mono text-xs">{microsoft.tenantId}</span>
              {microsoft.connectedBy &&
                ` by ${microsoft.connectedBy.firstName} ${microsoft.connectedBy.lastName}`}
              .
            </p>
            <p className="text-muted">Domains: {microsoft.domains.join(', ')}</p>
            <SyncStatus
              at={microsoft.lastSyncAt}
              detail={microsoft.lastSyncDetail}
              timezone={org.timezone}
            />
            <ConfigForm
              action={setAutoProvision.bind(null, 'MICROSOFT')}
              successMessage="Saved."
              className="flex flex-wrap items-center gap-3"
            >
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name="autoProvision"
                  value="true"
                  defaultChecked={microsoft.autoProvision}
                />
                Create employees for staff in the directory who have none
              </label>
              <SubmitButton label="Save" />
            </ConfigForm>
            <div className="flex flex-wrap gap-3">
              <ActionButton
                action={syncDirectoryNow}
                label="Sync now"
                pendingLabel="Syncing…"
                variant="primary"
              />
              <a href="/api/directory/microsoft/connect" className="th-btn-secondary">
                Reconnect
              </a>
              <ActionButton
                action={disconnectDirectory.bind(null, 'MICROSOFT')}
                label="Disconnect"
                confirmLabel="Disconnect Microsoft 365"
                variant="danger"
              />
            </div>
          </div>
        ) : (
          <div className="th-card space-y-3 p-4 text-sm">
            <p>
              Connect your Microsoft 365 tenant to import active staff from your directory, keep
              them in step daily, and link anyone signing in from your domains to their employee
              record automatically. A Microsoft 365 administrator approves read access to the
              directory on Microsoft&apos;s own page.
            </p>
            {isEntraConfigured ? (
              <a href="/api/directory/microsoft/connect" className="th-btn inline-block">
                Connect Microsoft 365
              </a>
            ) : (
              <p className="text-muted">Microsoft sign-in is not configured for this deployment.</p>
            )}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Google Workspace</h2>
        <div className="th-card space-y-3 p-4 text-sm">
          <p>
            {google
              ? `Registered domains: ${google.domains.join(', ')}. A Google account from one of them is linked to the employee with its address.`
              : 'Register your Workspace domains so Google accounts from them are linked to employees by address. Importing staff from Google is planned.'}
          </p>
          <ConfigForm
            action={registerGoogleWorkspace}
            successMessage="Saved."
            className="space-y-3"
          >
            <Field label="Workspace domains" name="domains" hint="Separate several with commas.">
              <input
                id="domains"
                name="domains"
                defaultValue={google?.domains.join(', ') ?? ''}
                className="th-input"
              />
            </Field>
            <SubmitButton label={google ? 'Update domains' : 'Register domains'} />
          </ConfigForm>
          {google && (
            <ActionButton
              action={disconnectDirectory.bind(null, 'GOOGLE')}
              label="Remove"
              confirmLabel="Remove Google Workspace"
              variant="danger"
            />
          )}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Needs review</h2>
        {review.length === 0 ? (
          <p className="text-sm text-muted">Nobody is waiting for review.</p>
        ) : (
          <>
            <p className="text-sm text-muted">
              Imported from the directory, or disabled there since. Nothing accrues for them and no
              timesheet is made until they have a pay schedule and leave policies.
            </p>
            <ul className="th-card divide-y divide-border text-sm">
              {review.map((e) => (
                <li key={e.id} className="px-4 py-2">
                  <Link
                    href={`/admin/employees/${e.id}`}
                    className="font-medium text-accent hover:underline"
                  >
                    {e.firstName} {e.lastName}
                  </Link>{' '}
                  <span className="text-muted">{e.email}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  )
}

function Method({ name, on, how }: { name: string; on: boolean; how: string }) {
  return (
    <li className="flex flex-wrap justify-between gap-2 px-4 py-2">
      <span>{name}</span>
      <span className={on ? 'text-green-700 dark:text-green-400' : 'text-muted'}>
        {on ? 'On' : `Off — set ${how}`}
      </span>
    </li>
  )
}

function SyncStatus({
  at,
  detail,
  timezone,
}: {
  at: Date | null
  detail: unknown
  timezone: string
}) {
  if (!at) return <p className="text-muted">Not synced yet.</p>
  const d = (detail ?? {}) as {
    error?: string
    created?: number
    linked?: number
    flaggedDisabled?: number
  }
  return (
    <p className={d.error ? 'text-danger' : 'text-muted'}>
      Last synced {formatTimestamp(at, timezone)}
      {d.error
        ? ` — failed: ${d.error}`
        : ` — ${d.created ?? 0} created, ${d.linked ?? 0} linked, ${d.flaggedDisabled ?? 0} flagged as disabled.`}
    </p>
  )
}
