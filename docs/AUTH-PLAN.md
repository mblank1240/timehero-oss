# Sign-in without Microsoft 365, and open-sourcing TimeHero

*Planned 2026-10-07; decisions made and the first half built the same day.*

TimeHero started as Microsoft-only for one church. To be usable by anyone, it
now offers several ways in, all ending at an employee record an administrator
created — or one created from the organization's own directory. Nobody
registers themselves.

## Decisions

| Question | Decision |
|---|---|
| Passwords? | **No.** Emailed sign-in links instead. Passkeys remain the fallback if ever needed. |
| Licence | **MIT** (`LICENSE`). |
| The original organization's name and data | Kept in private files that the public copy leaves out. The public repository ships a fictional example organization (`prisma/config/example.json`). |
| Which sign-in methods | **All of them, side by side**: Microsoft, Google and emailed links, each switched on by configuration. |

## Built

**Sign-in methods** (`lib/auth.ts`), each switched on by environment
variables; the sign-in page offers whichever are on.

| Method | Turned on by | Notes |
|---|---|---|
| Microsoft | `AUTH_MICROSOFT_ENTRA_ID_*` | As before, now through the `Identity` table. |
| Google | `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | Links by address only with a Google Workspace registered, and only addresses Google vouches for (`email_verified`). |
| Emailed link | `AUTH_EMAIL_LINKS=true` + outgoing mail + a sending address set by an administrator | `lib/sign-in-links.ts`. Without an address the option is hidden and requests are refused. |
| Development bypass | `DEV_AUTH_BYPASS=true` | Refused in production, as before. |

**Linked accounts.** `Identity (employeeId, provider, subject, tenant, email)`
replaced `Employee.entraOid`; the migration carried existing links across. An
account links on first sign-in and is matched by the provider's stable id
afterwards. Each employee's page lists linked accounts, with an audit-logged
unlink.

**The rules for linking** (`lib/directory/link.ts`, pure and unit-tested):

1. With the organization's directory registered, only its own accounts get
   in: the Microsoft tenant, or the Google Workspace domains. Anything else is
   refused.
2. A linked account is its employee.
3. Otherwise link by email — a verified address, and with a directory
   registered, one in the organization's domains. **This is the "anyone
   signing in with our domain is linked automatically" behaviour.**
4. Otherwise, with a Microsoft directory registered, create the employee from
   the directory after confirming the account is enabled.

A multi-tenant Microsoft app with no directory registered never links by
email: any Microsoft account anywhere could claim any address (the "nOAuth"
mistake). Nor does Google without a Workspace registered: anyone can make a
personal Google account on a work address, and it would outlive the job.
Without one, Google sign-in works only for an account already linked.

**Registering the organization — Microsoft.** Admin → Directory → *Connect
Microsoft 365* sends an administrator to Microsoft's admin-consent page. The
callback (`app/api/directory/microsoft/callback`) checks a state cookie, reads
the tenant's verified domains as the app — which succeeds only if consent was
really granted — records a `DirectoryConnection`, and runs a first sync.

**Directory sync** (`lib/directory/plan.ts` pure, `sync.ts` I/O; the daily
`sync-directory` job and a *Sync now* button):

- Enabled member accounts in the organization's domains are **imported** as
  employees, or **linked** to the employee with their address.
- Imported employees are **marked for review**, hourly, with no pay schedule
  and no leave policies — so nothing accrues and no timesheet is made until an
  administrator has set them up. Saving the record clears the mark. Hourly is
  the safe default: an hourly employee wrongly marked exempt could bank comp
  time, which FLSA forbids.
- A linked account later **disabled** in the directory flags its employee for
  review. Nobody is deactivated automatically: leaving is an HR decision with
  a termination date. But the employee cannot sign in by any route — Microsoft,
  Google or emailed link — and an open session ends, while any linked account
  is recorded as disabled (`Identity.directoryAccountEnabled = false`).
  Unlinking that account on the employee's page, or a sync that sees it
  enabled again, lets them back in.
- A linked account the directory **no longer lists** — deleted, usually,
  when someone leaves — is treated exactly as a disabled one: recorded as
  disabled, its employee flagged, and no sign-in by any route. That includes
  emailed links, since a leaver's address is often forwarded to a manager or
  turned into a shared mailbox. Restored within Microsoft's 30 days, it is
  let back in by the next sync. A sync that would find more than half of the
  linked accounts missing at once (and more than three) blocks nobody and
  says so on the Directory page: that is a permission or directory fault,
  not half the staff leaving. Accrual still stops only at a termination date
  or deactivation — the flag is the prompt to set one.
- Guests, disabled accounts nobody holds (shared mailboxes) and addresses
  outside the domains are skipped and counted. Domains are re-read each sync.
- With `chainsFromManager` on (the default), an employee whose approval
  chain is empty gets their Entra **manager** as step 1, when the manager is
  an active employee. A manager who changes later **flags** the employee for
  review unless their chain already starts with the new one; a chain is never
  rewritten. The first sync to read managers records them without flagging.
  `lib/directory/managers.ts` is the pure rule. The manager comes from
  `$expand=manager` and needs nothing beyond `User.Read.All`.

**Emailed links.** A request is recorded whether or not the address exists,
and answered the same way either way. Only an employee who may sign in gets a
token: 32 random bytes, stored as a SHA-256 hash, valid 15 minutes, spent once
by a conditional update so two clicks cannot both succeed. Five requests an
hour per address, twenty per IP, and a hundred links mailed an hour in all
(the constants in `lib/sign-in-links.ts`). The message is sent after the
response (`after()`), so a real address is not answered more slowly than an
unknown one. The link opens a page with a button, because mail scanners follow
links and would spend a token on a GET.

**Outgoing mail** (`lib/mail/`): `smtp` (nodemailer), `graph` (from a shared
mailbox with the Entra app's `Mail.Send`), and `file`/`console` for
development. Phase 8's notifications send through the same function. Since
Phase 8 the address mail comes from is an administrator's setting
(`OrgSettings.mailFromAddress`, Administration → Notifications), not the
environment: an organization gets email only from an address it chose, and
with none set nothing is sent — notifications go by push and the in-app list,
and emailed sign-in links are not offered. The transport and its credentials
stay in the environment.

**Also built alongside:** an employee's pay schedule and leave policies can
now be set on their page — neither was editable before, which the review of
imported staff needs.

## Not yet verified against the real services

There is no Entra tenant or Google project to test against yet, so the Graph
calls (`lib/microsoft/graph.ts`), the consent round trip and Google sign-in
are covered by tests with fakes, not live. Expect small fixes on first
contact. `docs/ENTRA-SETUP.md` now asks the tenant owner for the two
application permissions this needs (`User.Read.All`, and `Mail.Send` scoped to
the shared mailbox).

The per-IP limit reads the right-most `X-Forwarded-For` address — the one the
proxy in front of the app appended (App Service adds a port, which is
dropped); the entries before it are the client's to choose. A request with no
usable address shares one limit with every other such request. Behind more
than one proxy of your own, the right-most entry is your outer proxy's
address, so the per-IP limit becomes a shared one; the per-address and overall
limits do not depend on it.

## Planned: Google Workspace as a directory

Google sign-in and domain registration work now (*Admin → Directory → Google
Workspace*): a Google account from a registered domain is linked by address.
What is missing is reading the Workspace directory, so Google organizations
get no import and no create-at-sign-in yet. The shape is already in place —
`DirectoryConnection` takes `GOOGLE`, and `lib/directory/sources.ts` has the
slot that currently throws `DirectoryNotSupportedError`.

To build it:

1. **Credentials.** A Google Cloud service account with domain-wide
   delegation, granted the scope
   `https://www.googleapis.com/auth/admin.directory.user.readonly` in the
   Workspace admin console, impersonating a Workspace administrator. Stored
   as `GOOGLE_SERVICE_ACCOUNT_KEY` (the JSON key) and
   `GOOGLE_ADMIN_SUBJECT`. Unlike Microsoft there is no consent page to
   redirect through; the admin console step is manual, and the connection
   form should say so step by step.
2. **Registration.** The form takes the primary domain, calls
   `GET admin/directory/v1/customers/my_customer` to read the customer id and
   `GET .../domains` for the verified domains, and stores them on the
   connection — replacing today's typed-in list, as Microsoft does.
3. **The reader.** `directoryFor()` returns a Google implementation of
   `Directory`: `users.list?customer=my_customer` paged, mapped onto
   `DirectoryUser` — `id`, `name.givenName`/`familyName`, `primaryEmail`,
   `suspended` → `accountEnabled`, `creationTime` *not* used as a hire date.
   Google has no guest accounts, so `userType` is always `Member`.
4. **Then** turn on `autoProvision` for Google in `decideExternalSignIn`
   (one condition) and the "Create employees" toggle on the page. The planner,
   sync, review queue and job need no change.

About a day, plus the Workspace admin-console setup, which needs a real
Workspace to try.
