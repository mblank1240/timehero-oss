# TimeHero

Time and leave management for small organizations: PTO, sick leave, comp
time, approval chains, timesheets and payroll exports. Originally built for a
church's staff. Next.js and PostgreSQL; staff sign in with Microsoft 365,
Google, or an emailed link — no passwords. MIT licensed.

## What it does

- **Leave** with balances that are always explained: every grant, use,
  rollover and forfeit is an entry in an append-only ledger. Lump-sum or
  per-pay-period accrual, waiting periods, tenure tiers, rollover caps in the
  employee's own days, and carryover windows.
- **Requests and approvals** through per-employee approval chains, with an
  approver inbox, escalating reminders and a daily digest.
- **Comp time** banked from approved overtime by salaried exempt staff (and
  only them — FLSA).
- **Timesheets** for hourly staff: weekly overtime, due dates, approval, and
  payroll exports per employee, as a summary, or all at once.
- **Notifications** in the app, by Web Push, and by email from an address an
  administrator sets.
- **Reports** on balances, leave taken and forfeitures, exportable to CSV, for
  administrators and a read-only finance role.
- **Administrator overrides** for anything an employee or approver does, each
  with an audited reason.
- **Microsoft 365 directory import**, if you have one: staff are created and
  linked from it daily.

Every policy figure is configuration an administrator edits, never code
(`docs/CONFIGURATION.md`).

## Try it locally

Requires Node 22 and PostgreSQL 17 or later.

```bash
createdb timehero_dev
npm install
cp .env.example .env         # set DATABASE_URL, and AUTH_SECRET: openssl rand -base64 33
npm run db:migrate
npm run db:seed              # a fictional organization with sample staff
npm run dev
```

Open http://localhost:3000. With `DEV_AUTH_BYPASS=true` in `.env` and no
identity provider configured, the sign-in page offers a development bypass —
sign in as `admin@example.test` for an administrator,
`custodian@example.test` for an hourly employee, or `finance@example.test` for
the finance role. The rest of the sample staff are in `prisma/seed.ts`.

With `AUTH_EMAIL_LINKS=true`, emailed sign-in links — and notification
emails — are written to `.mail-outbox/` in development rather than sent. For
push notifications, put a VAPID key pair in `.env`
(`npx web-push generate-vapid-keys`), then turn them on from **Notifications**
in the header; browsers allow push on `localhost` without HTTPS.

## Running it for real

- **Docker** — `docker-compose.yml` runs the app, PostgreSQL, migrations and
  the scheduled jobs. Sign-in by emailed link over any SMTP server, or Google,
  or Microsoft. See `docs/SELF-HOSTING.md`.
- **Azure** — `infra/main.bicep` provisions App Service, PostgreSQL, Key Vault
  and monitoring, deployed by GitHub Actions. See `docs/AZURE-SETUP.md`.

Either way, `npm run setup` creates your organization from a configuration
file and its first administrator (`docs/CONFIGURATION.md`), and
`docs/GO-LIVE.md` covers importing staff and opening balances.

Sign-in methods and linking accounts to employees: `docs/AUTH-PLAN.md`.
Microsoft 365 sign-in and directory import: `docs/ENTRA-SETUP.md`.

## Scheduled jobs

Balances, timesheets, notifications and the staff directory are kept current
by seven jobs, which are HTTP routes authenticated with `JOBS_SECRET`. Something
has to call them on a schedule:

- **Docker:** the `jobs` service in `docker-compose.yml` (`docker/scheduler.mjs`).
- **Azure:** `.github/workflows/jobs.yml`, which skips with a notice until the
  repository has `APP_BASE_URL` (a variable) and `JOBS_SECRET` (a secret).
- **Anything else:** cron and `curl`, as below.
- **Locally:** **Admin → Jobs** runs the same code and writes the same run log.

A job that stops running is caught: Admin → Jobs flags it, and
`/api/health/jobs` answers 503 for a monitor to poll.

| Job | Cadence | Does |
|---|---|---|
| `accrue-pay-period` | Daily | Grants lump allotments that have come due, and accrues every pay period ending that day |
| `benefit-year-rollover` | Daily | Nothing except on the first day of the benefit year, when it forfeits closing balances, re-grants what is carried and posts the new allotments |
| `create-timesheets` | Daily | Creates a timesheet for every hourly employee in each pay period open that day |
| `expire-lots` | Daily | Forfeits whatever is left of a grant past its expiry date |
| `send-notifications` | Hourly | Approval reminders as they escalate, timesheet due and overdue reminders, approvers' daily digests; then delivers any push and email still pending |
| `sync-directory` | Daily | Imports and links staff from the registered Microsoft 365 directory; nothing until one is connected |
| `generate-pay-periods` | Weekly | Keeps 24 months of pay periods generated ahead |

```bash
curl -X POST -H "Authorization: Bearer $JOBS_SECRET" \
  "$BASE_URL/api/jobs/accrue-pay-period?date=2026-01-14"
```

Every job is idempotent and takes the date it acts on, so a run that was
missed or ran late is recovered by running it again for that date. Nothing is
ever granted twice: the ledger's unique index refuses it.

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Development server |
| `npm run check` | Typecheck and lint — run before calling work done |
| `npm test` | Unit tests — pure, no database needed |
| `npm run test:integration` | Integration tests against a migrated, seeded Postgres |
| `npm run test:e2e` | Playwright end-to-end tests |
| `npm run db:migrate` | Create and apply a migration |
| `npm run setup` | Set up a real installation: configuration and a first administrator, no demo data (`docs/CONFIGURATION.md`) |
| `npm run db:seed` | Seed demo data from `prisma/config/example.json` (`SEED_CONFIG=<file>` for another organization; `SEED_CONFIGURATION_ONLY=true` for production: configuration, no staff) |
| `npm run db:studio` | Browse the database |
| `npm run db:reset` | Drop, re-migrate and re-seed |

## Documentation

| File | Contents |
|---|---|
| `docs/SELF-HOSTING.md` | Running TimeHero with Docker Compose |
| `docs/CONFIGURATION.md` | An organization's configuration file and `npm run setup` |
| `docs/SPEC.md` | What the system does |
| `docs/DATA-MODEL.md` | Schema, the ledger, accrual and rollover algorithms |
| `docs/AUTH-PLAN.md` | Sign-in methods and how accounts are linked to employees |
| `docs/ENTRA-SETUP.md` | Microsoft 365 sign-in and directory import |
| `docs/AZURE-SETUP.md` | Deploying `infra/` to Azure |
| `docs/GO-LIVE.md` | From an empty database to the first pay period: configuration, the import, the parallel run |
| `docs/RUNBOOK.md` | Running production: alerts, missed jobs, the restore drill, secrets, rollback |
| `docs/ROADMAP.md` | How it was built, phase by phase |
| `docs/DECISIONS.md` | Why the architecture is what it is |
| `CLAUDE.md` | Stack, layout, and the rules that must not be broken — for contributors and coding agents |

## Contributing

Issues and pull requests are welcome; see `CONTRIBUTING.md`. Report security
problems privately, as `SECURITY.md` describes.

## Licence

MIT — see `LICENSE`.
