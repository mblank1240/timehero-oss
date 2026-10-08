# Self-hosting with Docker

`docker-compose.yml` runs everything TimeHero needs on one machine:

| Service | Does |
|---|---|
| `db` | PostgreSQL 17, data in the `db` volume |
| `migrate` | Applies pending migrations on every `up`, then exits |
| `app` | The server, on port 3000 (`TIMEHERO_PORT` to change it) |
| `jobs` | Calls the scheduled jobs on their timetable (`docker/scheduler.mjs`) |
| `tools` | Not started by `up`: `docker compose run --rm tools …` for setup, the import and Prisma |

You need Docker with Compose v2, a domain name, a reverse proxy that serves it
over HTTPS, and a way to sign staff in — an SMTP server for emailed links is
enough. Microsoft 365 and Google are optional.

## 1. Configure

```bash
git clone https://github.com/<you>/timehero && cd timehero
cp .env.docker.example .env.docker
```

Fill in `.env.docker`. Every variable is explained in `.env.example`; the ones
that matter here:

- `POSTGRES_PASSWORD`, and the same password inside `DATABASE_URL`.
- `APP_URL` and `AUTH_URL`: the HTTPS address staff will use. Sign-in links and
  redirects are built from it.
- `AUTH_SECRET` (`openssl rand -base64 33`) and `JOBS_SECRET`
  (`openssl rand -hex 32`).
- At least one sign-in method. Emailed links need `AUTH_EMAIL_LINKS=true`,
  `MAIL_TRANSPORT=smtp` and `SMTP_URL`. Google needs `AUTH_GOOGLE_ID` and
  `AUTH_GOOGLE_SECRET` (redirect URI `<APP_URL>/api/auth/callback/google`).
  Microsoft: `docs/ENTRA-SETUP.md`.

The app refuses to start with a configuration that cannot work — no sign-in
method, emailed links without mail, a missing `JOBS_SECRET` — and says which.

## 2. Start

```bash
docker compose up -d --build
docker compose logs -f app       # until it reports Ready
```

## 3. Set up the organization

Copy `prisma/config/example.json` to `prisma/config/<org>.json` and edit it —
leave types, policies, rollover, pay schedule and holidays
(`docs/CONFIGURATION.md`). Then create the organization and its first
administrator:

```bash
docker compose run --rm tools npm run setup -- \
  --config prisma/config/<org>.json \
  --admin-email you@example.org --admin-first-name Ada --admin-last-name Lovelace \
  --pay-anchor 2026-01-04 --mail-from time@example.org
```

`--pay-anchor` is the first day of a real pay period — ask payroll; it cannot
be corrected once timesheets exist. `--mail-from` is the address email comes
from, and staff signing in by emailed link need it. Then sign in at `APP_URL`
as the administrator and add staff under Administration → Employees, or import
them from CSV:

```bash
mkdir -p import && cp employees.csv import/
docker compose run --rm tools npx tsx --tsconfig tsconfig.json scripts/import.ts \
  --employees import/employees.csv            # a dry run; add --commit when it is clean
```

`docs/GO-LIVE.md` covers the import, opening balances and a parallel run.

## The reverse proxy

TimeHero must be reached over HTTPS: session cookies are `Secure`, and browsers
only allow push on HTTPS. With Caddy, for example:

```
time.example.org {
    reverse_proxy localhost:3000
}
```

## Upgrading

```bash
git pull
docker compose up -d --build     # migrate runs before the new app starts
```

## Backups

Everything is in PostgreSQL. A nightly dump is enough for most installs:

```bash
docker compose exec -T db pg_dump -U timehero -Fc timehero > timehero-$(date +%F).dump
```

Restore into an empty database with `pg_restore`. Test a restore before you
need one — `docs/RUNBOOK.md` has the drill, and `scripts/restore-check.ts`
compares a restored copy with the original.

## The scheduled jobs

The `jobs` container posts to `/api/jobs/*` at 07:00 UTC daily, 06:00 UTC on
Sundays and at a quarter past every hour, the same timetable as
`.github/workflows/jobs.yml`. Its log shows each run's response. If it was down
for a while, rerun a missed day from **Admin → Jobs**: every job takes the date
it acts on and never grants anything twice. `/api/health/jobs` answers 503
when a job is overdue, for an uptime monitor to poll.
