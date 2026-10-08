# Going live

The order of events from an empty production database to the first pay
period closed in TimeHero. Azure itself is `docs/AZURE-SETUP.md`. This page
picks up after its first deploy.

**Done when:** a pay period closes correctly in production with no manual
intervention.

## Before you start

Three things have to be settled first. None of them is code:

- [ ] **The Entra app registration** (`docs/ENTRA-SETUP.md`). Without a way to
      sign in, the app does not start in production.
- [ ] **The pay schedule anchor date**: the first day of a real pay period.
      Every period is generated from it, and once timesheets exist it cannot
      be corrected. It goes in `SEED_PAY_ANCHOR_DATE` below (`docs/CONFIGURATION.md`).
- [ ] **The cutover date**: the day your opening balances are correct at the
      end of. The last day of a pay period is easiest to reconcile.

## 1. Load the configuration

The seed loads the leave types, policies, rollover rules, carryover window,
holidays, departments and pay calendar from your organization's configuration
file, `prisma/config/<org>.json` (`docs/CONFIGURATION.md`). In
production it runs in **configuration-only** mode. It adds no sample staff,
and it refuses to start without the real anchor date.

Run it from your own machine. Open the database firewall to yourself first,
and close it afterwards:

```bash
MYIP="$(curl -fsS https://api.ipify.org)"
az postgres flexible-server firewall-rule create -g rg-timehero -n <postgresServerName> \
  --rule-name setup-$USER --start-ip-address $MYIP --end-ip-address $MYIP

export DATABASE_URL="$(az keyvault secret show --vault-name <keyVaultName> --name DATABASE-URL --query value -o tsv)"
NODE_ENV=production SEED_CONFIGURATION_ONLY=true SEED_CONFIG=prisma/config/<org>.json \
  SEED_PAY_ANCHOR_DATE=<YYYY-MM-DD> npm run db:seed
```

Keep the firewall rule open for steps 2 and 4, and delete it when you're done:

```bash
az postgres flexible-server firewall-rule delete -g rg-timehero -n <postgresServerName> \
  --rule-name setup-$USER --yes
```

## 2. Import the employees

`scripts/import.ts` reads a CSV of staff. It creates each employee with their
policies, department, pay schedule and approval chain. Templates are in
`scripts/import-templates/`.

```bash
npx tsx --tsconfig tsconfig.json scripts/import.ts --employees employees.csv
```

**It writes nothing without `--commit`.** The run happens inside a
transaction that is rolled back, so the report shows exactly what a real run
would do, constraint checks included. Fix what it reports and run it again
until it is clean, then add `--commit`. Any error at all rolls back the
whole file.

It is safe to re-run. An email that already exists is left alone, so new
rows can be added to the file and run again.

| Column | Required | Notes |
|---|---|---|
| `email` | yes | Their sign-in address |
| `first_name`, `last_name` | yes | |
| `role` | | `EMPLOYEE` (default), `ADMIN` or `FINANCE`. Make yourself `ADMIN` |
| `employment_type` | yes | `HOURLY` or `SALARIED_EXEMPT` (`exempt` is accepted). Comp time is exempt staff only |
| `hire_date` | yes | `YYYY-MM-DD`. Drives the waiting period |
| `termination_date` | | For someone who has left but still has a balance to settle |
| `department` | | Created if it doesn't exist |
| `pay_schedule` | | By name. Blank is the default schedule |
| `standard_day` | | `8h`, `450m`, `4h` for a half-day part-timer. Blank keeps the default |
| `policies` | | `PTO:Standard; SICK:Standard`. Leave type code, colon, policy name. `PTO:5+ Years` for the tier. `=12d` after a policy overrides the allotment for this person |
| `approvers` | | Emails in chain order, separated by `;`. They may appear later in the file |

Then **sign in** as the administrator you imported and check the
configuration in the app: Administration → Leave policies, Pay schedules,
Holidays, Notifications. In particular, check that **Administration →
Notifications** shows the sending address you expect (`mailFromAddress` in
the configuration file), or none if you send no email.

## 3. Turn on the scheduled jobs

The scheduled jobs start as soon as GitHub has `APP_BASE_URL` and
`JOBS_SECRET` (step 4 of `docs/AZURE-SETUP.md`). From then on they run
on their own every day. **Admin → Jobs** shows what ran, and an "overdue"
notice appears there, and an alert email goes out, if any job stops.

Lump grants written before the balances go in do no harm. The import
counts them (see below).

## 4. Import the opening balances

Export every employee's balance per leave type from the old system **as of
the cutover date**, and import it:

```bash
npx tsx --tsconfig tsconfig.json scripts/import.ts --balances balances.csv --as-of <cutover>
```

Dry run first, as before. The report shows each balance split into the
grants and the adjustment it will post:

```
  email                               type    opening     = grants    + adjustment
  pat.leader@example.org              PTO     76h         = 120h      + -44h
```

**Why it is split.** Posting each balance as one adjustment would be wrong.
The next accrual run would find no grant for the year and grant the whole
allotment again on top. So the import writes this year's grants exactly as
the jobs would have written them, then one `ADJUSTMENT` for the difference.
The adjustment carries everything the old system knew and this one doesn't:
leave used this year, last year's carry-over, past corrections. The balance
on the cutover date comes out at exactly the figure supplied, and every job
afterwards picks up from the right place.

| Column | Required | Notes |
|---|---|---|
| `email` | yes | Must exist, from step 2 or earlier |
| `leave_type` | yes | `PTO`, `SICK`, `COMP` |
| `balance` | yes | `9.5d`, `76h`, `-4h`. Days are the employee's own standard day |
| `expires_on` | | For comp time carried under the December window: the date it lapses |

**Give every employee a row for every leave type they hold, including
zeros.** The report warns about anyone it finds holding a policy with
nothing on the ledger. For those people, the next accrual run grants the
year's allotment in full, as for a new hire.

Each balance can be imported once. Its adjustment carries the key `OPENING`,
and a second run reports "already imported". Correct a wrong balance
afterwards with an ordinary adjustment under Admin → Ledger, with a
reason.

**Reconcile.** In **Reports → Balances**, set the date to the cutover, download
the CSV and compare it line by line with the old system's report. They should
agree to the minute.

## 5. Run one pay period in parallel

For one full pay period, staff use both the old process and TimeHero:
requests, approvals, overtime, timesheets. At the close, compare:

- [ ] **Timesheets.** Reports → Timesheets for the period, against what payroll
      received the old way: hours, overtime per workweek, leave and holiday
      hours.
- [ ] **Balances.** Reports → Balances on the period's last day, against the
      old system on the same day.
- [ ] **Leave taken.** Reports → Leave taken, against the old system's
      record for the period.
- [ ] **Approvals.** Every request reached the right approver, in chain order.
- [ ] **Jobs.** Admin → Jobs shows every daily job succeeding every day of
      the period, and no overdue notice.

Anything that disagrees is either a configuration difference (fix the
setting, then post an adjustment) or a bug (fix it, then run the period
again).

## 6. First real notifications

Graph mail and Web Push have so far only been tested against fakes. Expect
small fixes.

- [ ] **Push.** On a phone, open TimeHero, go to `/notifications`, turn push on
      and send yourself the test notification. On an iPhone, add the site
      to the home screen first; iOS only delivers push to installed sites.
- [ ] **Email.** Submit a leave request as someone whose approver has email on.
      The approver should get an email **from the sending address**. If it doesn't
      arrive, check: `MAIL_TRANSPORT=graph` is set (`mailTransport` in the
      parameter file), the registration has `Mail.Send` with admin consent,
      the application access policy allows that mailbox, and
      Administration → Notifications counts no failures.
- [ ] **Sign-in link.** Sign out and use "Email me a sign-in link".

## 7. Cut over

Stop the old process, tell staff, and keep the old system's final reports.
Phase 9 is done when the next pay period closes with nobody touching
anything.
