# Runbook

Running TimeHero in production. Setting it up is `docs/AZURE-SETUP.md` and
`docs/GO-LIVE.md`.

## Where to look

| Question | Place |
|---|---|
| Did last night's jobs run? | **Admin → Jobs**: every run, its result, and a "not run on schedule" notice for any job that has missed its slot |
| Why did a job fail? | The run's row in Admin → Jobs, then the **Scheduled jobs** workflow run in GitHub Actions |
| Is the site up? | `https://<address>/api/health`, and the `-site-up` availability test in Application Insights |
| Why is a page erroring? | Application Insights → Failures, or App Service → Log stream. Older console, HTTP and database logs are in the `-logs` Log Analytics workspace (`AppServiceConsoleLogs`, `AppServiceHTTPLogs`, `PostgreSQLLogs`) |
| Did a deploy go out? | The **Deploy** workflow in GitHub Actions |
| Did notifications go out? | Administration → Notifications counts failed deliveries |

Two alerts email whoever is in `alertEmails`:

- **Site down**: `/api/health` failing from two or more locations. The app
  is down or cannot reach its database.
- **Jobs not on schedule**: `/api/health/jobs` returns 503 when any scheduled
  job has not succeeded within its grace period. That is 3 hours for the
  hourly notification job, 30 for the daily jobs and 8 days for the weekly
  one. See below.

## A scheduled job stopped running

This alert exists because a job that *fails* turns its workflow red and gets
noticed, while a job that silently *stops* produces nothing at all.

1. **Admin → Jobs** names the job and when it last succeeded.
2. In GitHub, **Actions → Scheduled jobs**: are runs happening?
   - **No runs at all.** The workflow is disabled. GitHub disables
     scheduled workflows in a public repository after 60 days without
     activity. Re-enable it on that page. Also check that the
     `APP_BASE_URL` variable and `JOBS_SECRET` secret still exist. Without
     them the workflow skips with a notice rather than failing.
   - **Runs fail with 401.** `JOBS_SECRET` in GitHub no longer matches
     `JOBS-SECRET` in Key Vault.
   - **Runs fail with 5xx.** The job itself is failing: read the error on
     its row in Admin → Jobs.
3. **Catch up.** Every job takes the date it acts on and is idempotent, so
   a missed day is recovered by running that date. Run the dates in order,
   oldest first: **Admin → Jobs** has a date on each job, or use
   **Actions → Scheduled jobs → Run workflow** with a date. Running a date
   twice changes nothing. A date may reach back two years and no further
   ahead than tomorrow; anything outside that is refused as a likely typo.

   Two things catch up on their own once the jobs are running again:

   - **The benefit-year rollover.** The first run after the year's first day
     does the rollover if no run has yet, with the same figures it would have
     had on the day. Its run log says `caughtUp: true`. Only the current
     year's rollover is caught up this way; one missed in an earlier year is
     run by hand for that year's first day.
   - **The last pay period of a year.** The rollover settles it before it
     closes the year (`finalAccrualsSettled` in its run log). If the run log
     shows `finalAccrualsUntracked` above zero, the ledger had nothing at all
     for those employees in the closing year — usually an install that went
     live after it — and nothing was written for them; decide whether an
     adjustment is owed.

## A year began without a rollover

`/api/health/jobs` and Admin → Jobs also flag `benefit-year-rollover` when the
current benefit year is more than a day old and no run has rolled it over —
which a daily heartbeat cannot show, because the job succeeds every day. Since
the job catches up on its own, this means it is not running, or every run is
failing: read the error on its latest row in Admin → Jobs, fix the cause (a
failing run names the employees and leave types it could not finish), and run
it again. Everyone already done is skipped.

## Restoring the database

Azure takes the backups automatically: a daily snapshot plus transaction
logs, kept for 35 days and copied to the paired region. Any moment in that
window can be restored, **to a new server**. A restore never overwrites the
existing one.

### The drill: do this before go-live, then once a year

A backup nobody has restored is not a backup.

```bash
# A moment at least 15 minutes ago, in UTC:
AT=2026-12-01T10:00:00Z

az postgres flexible-server restore -g rg-timehero \
  --source-server <postgresServerName> --name <postgresServerName>-drill \
  --restore-time $AT

# Let yourself in to both:
MYIP="$(curl -fsS https://api.ipify.org)"
for s in <postgresServerName> <postgresServerName>-drill; do
  az postgres flexible-server firewall-rule create -g rg-timehero -n $s \
    --rule-name drill --start-ip-address $MYIP --end-ip-address $MYIP
done

PROD_URL="$(az keyvault secret show --vault-name <keyVaultName> --name DATABASE-URL --query value -o tsv)"
DRILL_URL="${PROD_URL/<postgresServerName>./<postgresServerName>-drill.}"

DATABASE_URL="$PROD_URL"  npx tsx --tsconfig tsconfig.json scripts/restore-check.ts --at $AT > prod.txt
DATABASE_URL="$DRILL_URL" npx tsx --tsconfig tsconfig.json scripts/restore-check.ts --at $AT > drill.txt
diff prod.txt drill.txt && echo "Restore verified"

az postgres flexible-server delete -g rg-timehero -n <postgresServerName>-drill --yes
az postgres flexible-server firewall-rule delete -g rg-timehero -n <postgresServerName> --rule-name drill --yes
```

`restore-check.ts` prints row counts, ledger sums per leave type and the
last audit row, all as of `--at`, ignoring anything written since. The two
outputs must be identical. Record the drill below.

| Date | Restored to | Result | By |
|---|---|---|---|
| | | | |

### A real restore

1. Restore to a new server, as in the drill, to just before the damage.
2. Add the app's outbound addresses to its firewall. They are listed on the
   web app under **Networking → Outbound addresses**. Alternatively, rename
   it to the old name and re-run the Bicep deployment, which adds them.
3. Point `DATABASE-URL` in Key Vault at the new server, then restart the web
   app.
4. Everything written after the restore point is gone. The audit log on the
   old server says what it was; re-enter it, or post adjustments.

## Secrets

All in Key Vault. App Service reads them at startup, so **restart the web
app after changing one**.

| Secret | Rotating it |
|---|---|
| `DATABASE-URL` | Re-run the Bicep deployment with a new `POSTGRES_ADMIN_PASSWORD`; it changes the server and the secret together. Restart the app straight away |
| `AUTH-SECRET` | Signs everyone out. Otherwise harmless |
| `JOBS-SECRET` | Change the GitHub secret `JOBS_SECRET` at the same time, or tonight's jobs fail with 401 |
| `ENTRA-CLIENT-SECRET` | **Expires.** Put the date in a calendar. An expired secret locks everyone out with an unhelpful error |
| `GOOGLE-CLIENT-SECRET`, `SMTP-URL` | When the provider requires it |
| `VAPID-PRIVATE-KEY` | **Don't.** A new pair silently unsubscribes every browser; everyone has to turn push on again |

## Deploys and rolling back

Every merge to `main` deploys once CI passes, after a reviewer approves it
if the `production` environment requires one. Migrations run first.

### Rolling back a deploy

There are no deployment slots: a deploy replaces the running code in place,
and if its smoke test fails, **the failed release is what is live**. The
Deploy run fails with an error saying so.

- **Fastest:** in **Actions → Deploy**, open the last run that succeeded and
  choose **Re-run all jobs**. It deploys the commit that run deployed (its
  `head_sha`), so the previous code is back in a few minutes. Its migrate
  step finds nothing to do.
- **Then, or instead:** **revert the commit on `main`**. That gives a normal
  deploy of the previous code, and keeps `main` matching what is live.

Migrations only go forward, which is why each one must work with the release
before it (see "Migrations run from the deploy, before the code" in
`docs/DECISIONS.md`): the old code runs fine on the new schema. A migration
that has to be undone gets a new migration.
