# TimeHero

Time & leave management for small organizations — built for a church of ~75-100 employees. Single Next.js app, on Azure or Docker.

## Stack

- **Next.js 16** (App Router, TypeScript, Server Actions) — one deployable
- **PostgreSQL** (Azure Database for PostgreSQL Flexible Server)
- **Prisma 7** — schema, migrations, queries. Connection config lives in
  `prisma.config.ts`, not the schema, and the client needs the `@prisma/adapter-pg` adapter
- **Auth.js v5** — Microsoft Entra ID, Google, and passwordless emailed links. No
  passwords, ever. Every way in ends at an existing employee, or one created from the
  organization's own directory — never self-registration. `docs/AUTH-PLAN.md`
- **Tailwind 4** — shared component classes in `app/globals.css` (`th-btn`, `th-input`, …).
  shadcn/ui is deferred to Phase 2; see the note in docs/ROADMAP.md
- **Zod** — validate every input at the server boundary
- **Vitest** (unit, accrual math) + **Playwright** (critical flows)
- **Mail** through `lib/mail` — Microsoft Graph from a shared mailbox, or SMTP; the address it is
  sent from is an admin setting (`OrgSettings.mailFromAddress`), and with none set no email is sent
- **Web Push** through `web-push` (VAPID keys in the environment) and `public/sw.js`
- Deploy: GitHub Actions → Azure App Service (`.github/workflows/deploy.yml`, Next's standalone
  output, infrastructure in `infra/`). Scheduled jobs: GitHub Actions cron → authenticated
  `/api/jobs/*` route. Migrations run from the deploy before the new code starts, so each
  must be safe for the release before it

## Layout

```
app/             routes — app/admin/* is admin-only, app/reports/* is admin or finance,
                 everything else is per-user
components/      shared React components; config-fields.tsx is shared by each
                 configuration screen's add form and its edit page
lib/env.ts       parsed environment; throws at boot on a bad config
lib/db.ts        Prisma client singleton
lib/auth.ts      Auth.js config and the sign-in gate
lib/sign-in-links.ts  emailed sign-in links: request, rate limits, single-use tokens
lib/directory/   linking accounts (pure rules), the directory sync (pure plan + I/O),
                 Microsoft admin consent
lib/microsoft/   Microsoft Graph as the app: directory reads and mail
lib/mail/        sendMail() over smtp | graph | file | console
lib/authz.ts     requireUser / requireAdmin / requireReportsAccess — role re-read from the DB each call
lib/roles.ts     what each role may do, as pure functions (finance reads reports, writes nothing)
lib/audit.ts     writeAudit + diff
lib/accrual/     the engine — pure functions, no Prisma, heavily tested; comp.ts
                 decides what an approved overtime log banks
lib/ledger/      reading and writing ledger rows; resolving who accrues what
lib/employees/   employee records; assignments.ts holds the pure policy-assignment
                 rules (who may hold a leave type, overlapping dates)
lib/employee-types/  employee types: the pure plan of a new hire's policies, the
                 service and actions — a pre-fill only, never re-applied
lib/jobs/        the seven scheduled jobs, their shared secret and their JobRun log —
                 send-notifications is hourly, the rest daily or weekly; health.ts
                 is missed-run detection. Jobs stamp ledger rows with their jobRunId
lib/requests/    leave requests: chain snapshot and advance (pure), day rules, the
                 projected-balance assessment, the transactional service (including
                 administrators entering and amending leave), list filters
lib/overtime/    overtime logs: schema, the transactional service (same chain as
                 requests), and the reads behind the overtime and approval pages
lib/dashboard/   the employee dashboard — next accrual and forfeit read off the projection
lib/history/     the history heatmap grid (pure) and the days it is drawn from
lib/timesheets/  hourly timesheets: weekly overtime and the day grid (pure), the
                 transactional service (same chain again), the period report and export
lib/notifications/  which channels (pure), escalation slots (pure), creating rows inside
                 the caller's transaction, the approval events, push and email delivery
lib/reports/     the /reports queries, their filters and CSV rows (pure)
lib/import/      the one-time import: CSV rows (pure) and the transactional service;
                 opening balances are planned by lib/accrual/opening.ts
lib/csv.ts       writing CSV, formula-safe, and reading it for the import
lib/zip.ts       writing a stored .zip, for "download all" exports
prisma/          schema.prisma, migrations, seed.ts
prisma/config/   an organization's starting configuration: organization.ts (schema),
                 apply.ts (writes it), example.json (fictional; dev, CI and tests)
scripts/         setup.ts (configuration and a first administrator), import.ts
                 (employees and opening balances), restore-check.ts
docker/          scheduler.mjs, the scheduled jobs for docker-compose.yml
infra/           Bicep for Azure — main.bicep, modules/, one .bicepparam per organization
tests/unit/        Vitest, pure — no database
tests/integration/ Vitest against real Postgres (npm run test:integration)
tests/e2e/         Playwright
docs/            SPEC, DATA-MODEL, ROADMAP, DECISIONS, CONFIGURATION, SELF-HOSTING,
                 AUTH-PLAN, ENTRA-SETUP, AZURE-SETUP, GO-LIVE, RUNBOOK
```

**The engine is pure and the service layer does the I/O.** Everything in
`lib/accrual/` takes plain data and returns the ledger entries it believes
should exist; it never reads or writes. `lib/ledger/` and `lib/jobs/` persist
the result. Put new accrual logic in the pure half, where it can be tested
against figures you can check by hand.

## Non-negotiable rules

1. **Policy is data, never code.** No organization-specific number may appear as a literal in application code — not the 120-day waiting period, not the 5-day PTO rollover, not the December comp window. All of it lives in `OrgSettings` / `LeavePolicy` / `RolloverRule` / `CarryoverWindow` rows, editable by an admin in the UI. Starting values live in a configuration file (`docs/CONFIGURATION.md`). If you find yourself writing `120` or `December`, you're building the wrong thing.
2. **Balances are never stored as a mutable number.** Every grant, use, rollover, forfeit, and adjustment is an immutable `LedgerEntry`. Balance = `SUM(minutes)`. Corrections are new entries, never updates or deletes.
3. **Accrual jobs must be idempotent.** Unique index on `(employeeId, leaveTypeId, kind, periodKey)`, with writes going through `createMany({ skipDuplicates: true })`. A re-run grants nothing twice because the database refuses it, not because the code remembered to check. Every job also takes the date it acts on, so a backfill and a late run are the same code path.
4. **Comp time is for exempt (salaried) employees only.** FLSA forbids private employers giving non-exempt staff comp time instead of overtime pay. Enforce in the schema and at the API boundary.
5. **Every duration is a signed integer count of minutes.** No floats, no `Decimal`, no column named `hours`. Hours and days exist only in the formatting layer — never compute on a formatted value.
6. **Employee-entered durations must be a multiple of `OrgSettings.minimumRequestIncrementMinutes`** (default 240 = half a day). Validate in the Zod schema *and* in the service layer. Accruals are exempt — those are exact to the minute.
7. **Leave dates are `DATE`** (no timezone). Audit timestamps are `timestamptz`.
8. **Authorization is checked server-side on every request.** Never trust a client-sent `employeeId` or role.
9. Anything touching the ledger, approvals, or policy writes an `AuditLog` row.

## Commands

```bash
npm run dev          # local dev
npm run db:migrate   # prisma migrate dev
npm run db:studio    # inspect data
npm test             # vitest — pure unit tests, no database needed
npm run test:integration  # vitest against a migrated, seeded Postgres
npm run test:e2e     # playwright
npm run check        # tsc --noEmit && eslint
```

Run `npm run check` before declaring work done.

## Conventions

- Server Actions for mutations; route handlers only for webhooks, cron, and file exports.
- One Zod schema per action, colocated, exported so tests reuse it.
- No `any`. No `@ts-expect-error` without a comment explaining the plan to remove it.
- Dates render in the org's configured timezone, never the server's.

## Reading order for a new task

`docs/SPEC.md` for behavior → `docs/DATA-MODEL.md` for schema → `docs/ROADMAP.md` for what's next.
Don't read all four docs unless the task actually spans them.
