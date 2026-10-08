# Microsoft Entra ID setup

TimeHero signs staff in with their existing M365 accounts. Nothing works until an
app registration exists in the organization's tenant.

Until then the app runs on a development bypass (`DEV_AUTH_BYPASS=true`) that signs
in as any seeded employee by email address. `lib/env.ts` refuses to start if that
flag is ever set in production, and there is no exemption — not even for tests.

---

## Part 1 — The request to send to whoever owns the tenant

> **Subject: App registration request — staff time-off system**
>
> We're deploying an internal web application for staff PTO, sick leave, comp time
> and timesheets. Staff will sign in with their existing Microsoft 365 accounts
> rather than a separate password, so nothing new to remember and access ends
> automatically when an account is disabled.
>
> Could you create an Entra ID app registration with the following?
>
> | Setting | Value |
> |---|---|
> | Name | TimeHero |
> | Supported account types | Accounts in this organizational directory only (single tenant) |
> | Platform | Web |
> | Redirect URI (production) | `https://<APP-DOMAIN>/api/auth/callback/microsoft-entra-id` |
> | Redirect URI (local development) | `http://localhost:3000/api/auth/callback/microsoft-entra-id` |
> | Redirect URI (directory consent) | `https://<APP-DOMAIN>/api/directory/microsoft/callback` |
> | Front-channel logout URL | `https://<APP-DOMAIN>/api/auth/signout` |
> | Client secret | 24-month expiry, please note the expiry date |
>
> **API permissions — delegated, Microsoft Graph:** `openid`, `profile`, `email`,
> `User.Read`. These are the default sign-in scopes. `User.Read` reads only the
> signed-in user's own basic profile.
>
> **API permissions — application, Microsoft Graph** (these need admin consent):
>
> - `User.Read.All` — read the staff directory, so active staff are imported
>   automatically and anyone signing in from our domains is matched to their
>   record. Read-only; nothing is written to the directory.
> - `Mail.Send` — send notifications and sign-in links from the shared mailbox
>   `time@<OUR-DOMAIN>`. Please **restrict it to that one mailbox** with an
>   Exchange application access policy
>   (`New-ApplicationAccessPolicy -AccessRight RestrictAccess`), so the app
>   cannot send as anyone else.
>
> Consent can be granted in the portal, or by an administrator following the
> "Connect Microsoft 365" button in TimeHero, which opens Microsoft's own
> consent page. We are not requesting any other write scope, or access to
> files or calendars.
>
> Please send back the **Application (client) ID**, the **Directory (tenant) ID**,
> and the **client secret value** (the value, not the secret ID — it's only
> visible once). The secret is a credential; please send it through the password
> manager rather than email.

Fill in `<APP-DOMAIN>` before sending. If it isn't decided yet, the redirect URI can
be added later without recreating the registration.

---

## Part 2 — Wiring it up once you have the three values

Locally, put them in `.env`. In production, the ID and tenant go in the
Bicep parameter file and the secret goes in Key Vault as
`ENTRA-CLIENT-SECRET`; see `docs/AZURE-SETUP.md`. The app's address, and so
the redirect URIs, are covered in Part 3 there.

For `.env`:

```bash
AUTH_MICROSOFT_ENTRA_ID_ID="<Application (client) ID>"
AUTH_MICROSOFT_ENTRA_ID_SECRET="<client secret VALUE>"
AUTH_MICROSOFT_ENTRA_ID_ISSUER="https://login.microsoftonline.com/<Directory (tenant) ID>/v2.0"
DEV_AUTH_BYPASS="false"
```

To send mail through Graph, add `MAIL_TRANSPORT="graph"`. The mailbox it
sends from is not an environment variable: it is set in the app under
**Administration → Notifications** (the configuration file's `mailFromAddress` sets the starting value) and must be
the mailbox the application access policy above allows.

All three Entra values are required together — the app refuses to start with a
partial configuration, because a half-configured tenant is painful to diagnose
from the error Entra returns.

Restart, and the sign-in page shows **Sign in with Microsoft** instead of the
development form.

## Connecting the directory

Once the app has `User.Read.All`, an administrator opens **Admin → Directory**
and clicks **Connect Microsoft 365**. Microsoft's consent page opens; after a
tenant administrator approves, TimeHero records the tenant and its verified
domains and imports every enabled member account as an employee (guests,
disabled accounts like shared mailboxes, and addresses outside the domains
are skipped). The `sync-directory` job repeats this daily.

Imported employees are **marked for review**: they start hourly, with no pay
schedule and no leave policies, so nothing accrues and no timesheet is made
until an administrator confirms their details and saves the record.

## How an account becomes a user

There is no self-registration. On a Microsoft sign-in:

1. With a directory connected, the account must belong to its tenant —
   anything else is refused.
2. An account already linked to an employee signs straight in.
3. Otherwise it is linked to the employee with the same email address, if the
   address is in one of the tenant's verified domains.
4. Otherwise, with a directory connected, the employee is created from the
   directory (marked for review), after checking the account is enabled.
5. Inactive or terminated → refused, with a message to contact an administrator.

Without a directory connected, step 3 links by exact email address only, and
step 4 does not happen — an administrator must create the employee first. A
multi-tenant app registration (`common` or `organizations` issuer) refuses
linking by email entirely until a directory is connected, because any
Microsoft account anywhere could otherwise claim an employee's address.

Linked accounts are listed, and can be unlinked, on each employee's page.

## Rotating the secret

Client secrets expire. When the replacement is issued, update
`AUTH_MICROSOFT_ENTRA_ID_SECRET` and restart — no code change, no migration.

Put the expiry date in a shared calendar when the secret is created. An expired
secret locks out every user at once, with an error that doesn't obviously say why.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `AADSTS50011: redirect URI mismatch` | The URI in the registration doesn't exactly match the app's address, including `https` and any trailing path |
| Signs in, then "not linked to an active employee record" | No employee row with that email, or the row is inactive or terminated |
| `AADSTS7000215: invalid client secret` | The secret ID was used instead of the secret value, or it has expired |
| App won't start, "Entra ID is partially configured" | One or two of the three values are set; set all three or none |
