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

- `POSTGRES_PASSWORD` (`openssl rand -hex 24`; never the example's
  `change-me`), and the same password inside `DATABASE_URL`.
- `APP_URL` and `AUTH_URL`: the HTTPS address staff will use. Sign-in links and
  redirects are built from it.
- `AUTH_SECRET` (`openssl rand -base64 33`) and `JOBS_SECRET`
  (`openssl rand -hex 32`). Each at least 32 characters.
- At least one sign-in method. Emailed links need `AUTH_EMAIL_LINKS=true`,
  `MAIL_TRANSPORT=smtp` and `SMTP_URL`. Google needs `AUTH_GOOGLE_ID` and
  `AUTH_GOOGLE_SECRET` (redirect URI `<APP_URL>/api/auth/callback/google`).
  Microsoft: `docs/ENTRA-SETUP.md`.

The app refuses to start with a configuration that cannot work or is unsafe —
no sign-in method, emailed links without mail, a missing `APP_URL`, a missing
or short secret, `MAIL_TRANSPORT=file` or `console` — and says which.

## 2. Start

```bash
docker compose up -d --build
docker compose logs -f app       # until it reports Ready
```

That builds the images from your checkout. To run a published release instead,
pull its images — `ghcr.io/mblank1240/timehero` and `timehero-tools`, for
linux/amd64 and arm64 — and start without building:

```bash
echo TIMEHERO_VERSION=0.1.0 >> .env     # or leave unset for the latest release
docker compose --profile tools pull
docker compose up -d --no-build
```

`TIMEHERO_VERSION` (and `TIMEHERO_IMAGE`, for images published from a fork)
are read by Compose from your shell or from `.env` beside
`docker-compose.yml`, not from `.env.docker`. Use the checkout of the same
release (`git checkout v0.1.0`), so `docker-compose.yml` and the
configuration examples match the images.

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

On published images, check out the new release, set `TIMEHERO_VERSION` to it,
then `docker compose --profile tools pull && docker compose up -d --no-build`.
Read its release notes first: they say when an upgrade needs anything more.

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
`.github/workflows/jobs.yml`. Its log shows each run's response. Started after
07:00 UTC, it runs the daily jobs once straight away, so a restart that spans
the daily slot does not skip that day. If it was down for longer, rerun a
missed day from **Admin → Jobs**: every job takes the date it acts on and never
grants anything twice. `/api/health/jobs` answers 503
when a job is overdue, for an uptime monitor to poll.

## Without Docker

Any host that runs Node 22 and can reach PostgreSQL 17 or later will do: a
Linux server under systemd, or a platform such as Render, Railway or Fly.io.
What the Docker setup does for you, you then do yourself:

1. **Configure** the same environment variables as above, in whatever way the
   host takes them. `NODE_ENV=production` must be set when the server runs.
2. **Build** Next's standalone server. `prisma.config.ts` reads `DATABASE_URL`
   during the install and build, but nothing connects, so a placeholder is fine:

   ```bash
   export DATABASE_URL=postgresql://build@localhost:5432/build
   export AUTH_SECRET=build-only-placeholder-not-used-at-runtime
   npm ci
   npm run build
   cp -r public .next/standalone/public
   cp -r .next/static .next/standalone/.next/static
   ```

3. **Migrate before every start** of a new release, with the real
   `DATABASE_URL`: `npx prisma migrate deploy`. On a platform this is its
   release or pre-deploy command. Each migration is safe for the release
   before it, so the old version may keep serving while it runs.
4. **Start** the server: `node .next/standalone/server.js`, with `PORT` (default
   3000) and `HOSTNAME=0.0.0.0` if the host routes to it from outside. It
   checks its configuration as it starts and exits, saying what is wrong,
   rather than serve with a bad one. `/api/health` is its health check.
5. **Set up the organization** once, from a checkout with the real
   `DATABASE_URL`: `npm run setup -- …` exactly as in step 3 above, minus
   `docker compose run --rm tools`.
6. **Serve it over HTTPS** — a platform does this for you; on your own server,
   the reverse proxy above.
7. **Schedule the jobs.** Something must call them, with `JOBS_SECRET`:

   ```cron
   # The daily batch, in this order: expiry is settled before the rollover
   # reads balances, and the rollover before the new year's accrual.
   0 7 * * *  for j in expire-lots benefit-year-rollover accrue-pay-period create-timesheets sync-directory; do curl -fsS -X POST -H "Authorization: Bearer $JOBS_SECRET" "$APP_URL/api/jobs/$j"; done
   15 * * * * curl -fsS -X POST -H "Authorization: Bearer $JOBS_SECRET" "$APP_URL/api/jobs/send-notifications"
   0 6 * * 0  curl -fsS -X POST -H "Authorization: Bearer $JOBS_SECRET" "$APP_URL/api/jobs/generate-pay-periods"
   ```

   Times are UTC, matching `docker/scheduler.mjs` and
   `.github/workflows/jobs.yml`; each job acts on the organization's own date
   whatever the hour. A platform's cron feature, or the GitHub Actions
   workflow in `.github/workflows/jobs.yml` (it needs only `APP_BASE_URL` and
   `JOBS_SECRET`), works as well as crontab.

Backups and upgrades follow the same pattern as above: `pg_dump` against your
database, and for an upgrade build, migrate, then restart.
