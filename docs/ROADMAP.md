# Roadmap

Each phase is independently demoable. Finish a phase and its tests before starting the next.
Mark items `[x]` as they land — this file is the running status of the build.

## Phase 0 — Skeleton ✅

- [x] `create-next-app` (Next 16, TypeScript, App Router, Tailwind 4)
- [x] Prisma 7 + local Postgres via Homebrew; `npm run check` wired up
- [x] Vitest + Playwright configured
- [x] GitHub repo, Actions CI running check, unit tests, build and e2e
- [ ] shadcn/ui — deferred, see note below

**Done when:** CI is green on an empty app.

> **shadcn/ui deferred.** Its CLI now requires an interactive choice of
> component library (Base UI / React Aria / Radix). Phase 1 uses plain Tailwind
> component classes in `app/globals.css`. Run `npx shadcn@latest init` and pick
> a library when Phase 2 brings real widgets — date pickers and comboboxes are
> where it starts paying for itself.

## Phase 1 — Auth & people ✅

- [x] Auth.js v5 with the Entra provider; match on `oid`, falling back to email
- [x] Bind `entraOid` at first sign-in so a later email change can't lock anyone out
- [x] Deny sign-in for unmatched, inactive or terminated employees, with a clear message
- [x] Development bypass to stand in until Entra exists, impossible to enable in production
- [x] Admin: employee create/edit, departments, role and employment-type assignment
- [x] Approval chain editor — ordered, reorderable, self-approval blocked
- [x] Audit logging on every employee, department and chain change
- [x] Seed script: org settings, departments, six employees covering the edge cases
- [x] Route guards (`requireUser`, `requireAdmin`, `requireAdminOrThrow`), enforced in
      Server Actions as well as layouts
- [x] 28 unit tests and 11 end-to-end tests, including employee-cannot-reach-admin
- [ ] Entra app registration — blocked on tenant access; request drafted in `docs/ENTRA-SETUP.md`

**Done when:** you can sign in with your real M365 account and see a dashboard.
*Everything behind the tenant registration is built and tested; swapping the bypass
for real Entra is three environment variables.*

## Phase 2 — Calendar & policies ✅

- [x] Pay schedule CRUD + period generation, tested across all four schedule types
- [x] Holiday management
- [x] Leave type CRUD
- [x] Leave policy CRUD and per-employee assignment with allotment override
- [x] Org rollover rules (all four cap bases) and carryover window CRUD
- [x] Seed script reflecting the church's configuration, including 72 generated pay periods
- [x] Org settings: benefit year, minimum request increment (240), timesheet increment (15), display unit
- [x] `formatDuration()` / `parseDuration()` / `validateRequestedMinutes()` / `incrementOptions()`, 66 unit tests
- [x] `generatePeriods()` / `periodsPerYear()` / `periodContaining()`, 41 unit tests
- [x] Period generation as a *scheduled* job — `generate-pay-periods` under `/api/jobs/*`, sharing `lib/payperiods/sync.ts` with the admin screen

**Done when:** an admin can fully configure the org with no leave existing yet.

---

# Start here — state as of 2026-10-07

Phases 0-8 are complete, plus sign-in without Microsoft 365, and **Phase 9 is
built up to the point where it needs Azure**, plus administrator overrides: 445 unit tests, 126 integration
tests against a real Postgres, and 64 end-to-end.

Working today: Microsoft 365 sign-in (on the development bypass until Entra
exists), employees, departments, approval chains, audit logging, the whole
configuration layer, and **the ledger and accrual engine** — balances, lump
grants, per-pay-period accrual, benefit-year rollover, carryover windows, lot
expiry, manual adjustments, and the scheduled jobs — and **leave
requests**: the request form with its projected balance, approval chains
snapshotted at submission, the approver inbox, cancellation, and administrator
overrides — and **the employee's own views**: a dashboard with balances, booked
and pending time, the next accrual and any coming forfeit; a history heatmap
with a filterable table; and "My requests" with filters and chain position —
and **comp time**: exempt staff log overtime, it goes through their approval
chain, and the final approval banks it as Comp Time at the org multiplier,
spendable as ordinary leave — and **timesheets**: a daily job creates one per
hourly employee per open pay period, the employee enters time worked with
leave and holidays filled in, overtime is computed per workweek, and it goes
through the approval chain to lock; administrators see who has submitted,
unlock with a reason, and download the period for payroll — one employee's CSV,
a summary, or all of them as a zip — as can the new read-only **finance**
role, under **Reports** — and **sign-in without passwords from anywhere**:
Microsoft, Google, or an emailed link, with accounts linked to employees by
address within the organization's own tenant or domains, and **Connect
Microsoft 365** importing active staff from the directory daily, marked for
an administrator's review — and **notifications**: approvers hear when
something waits on them and are chased while it waits, employees hear the
decision and when a timesheet is due or overdue, administrators get the
year-end rollover summary; in the app, by Web Push, and by email from an
address an administrator sets (none set, no email), each person choosing per
type, with an optional daily digest for approvers — and **reports** for
administrators and finance: balances as of a date, leave taken, forfeitures and
one employee's whole ledger, each downloadable as CSV. Licensed MIT.

Phase 9 added everything production needs that does not need the
subscription itself: the Bicep in `infra/`, a deploy workflow, health checks
with **missed-run alerts**, ledger entries stamped with the **JobRun** that
wrote them, a configuration-only production seed, the **one-time import** of
real employees and opening balances, and a **restore drill**. What is left is
provisioning and loading data, in the order `docs/GO-LIVE.md` gives.

**Web Push needs VAPID keys in `.env`** (`npx web-push generate-vapid-keys`,
see `.env.example`); without them push is off and everything else works.
**Emailed sign-in links now need a sending address** under Administration →
Notifications — the sample seed sets `time@example.test`; re-run `npm run db:seed` on an
older database.

**Restart `npm run dev` after pulling a schema change.** A running dev server
keeps the Prisma client it started with; `lib/db.ts` now detects that and says
so instead of failing with `undefined`.

**The integration tests need a database.** `npm test` is pure and needs
nothing; `npm run test:integration` needs a migrated, seeded Postgres and is a
separate CI step.

**`JOBS_SECRET` is new in `.env`.** Without it the `/api/jobs/*` routes refuse
every request with a 503; `lib/env.ts` requires it in production. Locally the
jobs are easier to drive from **Admin → Jobs** anyway, which authenticates as
an administrator instead. `.github/workflows/jobs.yml` runs them on a schedule
in production and stays inert until Phase 9 provisions the URL and the secret.

## Blocked on the church, not on code

Two hard blockers, each with its request written and ready to send:

- **The Entra ID app registration** (`docs/ENTRA-SETUP.md`). Three values and
  real Microsoft sign-in works, with no code change. Until then everything
  runs on the development bypass, which `lib/env.ts` refuses to allow in
  production, so production cannot start without it.
- **An Azure resource group with Owner on it** (`docs/AZURE-SETUP.md`, Part
  1). Someone else owns the subscription; nothing here can be provisioned
  until they say yes.

**The real allotments arrived on 2026-10-07 and are in the church's own
configuration file**, kept out of the public copy.

Six things are still open, all listed under "Still to confirm" in the church's
configuration notes.
The blocking one is the **pay schedule anchor date** — every pay period is
generated from it, so it has to be a real period start before anything is
seeded for production. The production seed now refuses to run without it
(`SEED_PAY_ANCHOR_DATE`). The others are a policy choice about proration for a
mid-year sick grant, deciding which employees sit on the 10+ Years tier, and
confirming the working week (seeded Monday to Friday; it only sets the request
form's defaults). Phase 7 added two: **the export format finance needs**
(the CSVs are a reasonable default until they say), and **holiday pay for
part-time hourly staff** (paid at their own day, capped at the holiday's
hours). The pay calendar itself is settled: Sunday to the second Saturday,
due the following Tuesday.

## Reading order for what's next

**To go live**, follow `docs/AZURE-SETUP.md` (send Part 1 first), then
`docs/GO-LIVE.md`. `docs/RUNBOOK.md` is for after.

**For Phase 10**, read Phase 10 below, then "Ledger entries record the run that
wrote them" and "An opening balance is this year's grants plus one
adjustment" in `docs/DECISIONS.md`. Reversing a run is
`WHERE "jobRunId" = $1`, and the reversal must leave the import's `OPENING`
adjustments alone, since they have no run.

What production still has that development does not:

- **First contact with real services**: Graph mail, Graph directory reads and
  Web Push to real browsers have only been tested against fakes. Expect
  small fixes; `docs/GO-LIVE.md` step 6 lists what to try.
- **Bicep compiles but has never been deployed.** Expect the first
  `az deployment group create` to turn up something, most likely around
  the custom-domain certificate or a role assignment racing its identity.
  Re-running is safe.

## Phase 3 — The ledger and accrual engine ✅

This is the heart of the system. Build it as pure functions in `lib/accrual/` before wiring any UI.

- [x] `LedgerEntry` schema with the idempotency unique index, plus CHECK constraints and triggers for the sign-by-kind, adjustment-reason, comp-is-exempt-only and append-only invariants
- [x] `balanceAsOf(employeeId, leaveTypeId, date)` — a plain aggregate, and `balanceOf()` over entries in hand
- [x] `accruePayPeriod(period)` — cumulative-target grants, `maxBalanceMinutes` ceiling, waiting period
- [x] `grantLump(employee, policy, year)` — the `max(yearStart, hireDate + waitingPeriodDays)` formula, all three `firstYearGrant` modes
- [x] `lotBalances(employee, type, asOf)` — replay the ledger into lots, consuming soonest-to-expire first
- [x] `runRollover(benefitYearStart)` — forfeit full closing balance, then re-grant carried amounts, then lump grants
- [x] Rollover caps including `EMPLOYEE_DAYS` basis
- [x] `CarryoverWindow` evaluation and `expiresOn` stamping
- [x] `expireLots()` job
- [x] Manual admin adjustment with a required reason, on `/admin/ledger`
- [x] Job runner routes under `/api/jobs/*`, shared-secret authenticated, writing `JobRun` — plus `/admin/jobs` to run one by hand and read the log

**Tests to write here — don't skip these:** *(all written — see the two bugs they caught, below)*
- [x] Re-running any job twice creates no duplicate entries
- [x] Rollover with a balance under, at, and over the cap
- [x] Rollover for a type with `countsTowardRollover = false`
- [x] **Rollover does not double a balance** — a 200-minute balance with an unlimited cap is still 200 after rollover, not 400. The forfeit-then-regrant pair is easy to get wrong.
- [x] March 1 hire, 120-day wait → full allotment on June 29, nothing on January 1
- [x] **November 1 hire, 120-day wait → nothing in the hire year, full allotment dated March 1 of the next year**, and no second grant on January 1
- [x] Someone who leaves before their waiting period ends is granted nothing
- [x] PTO cap of 5 `EMPLOYEE_DAYS` resolves to 2400 minutes at 480/day and 1200 at 240/day
- [x] **Comp earned in December survives into the new year; comp earned in November does not**
- [x] Carried December comp is forfeited on March 1, and the forfeit is exactly what went unspent
- [x] Comp spent in January draws down the December lot, not a January-earned one
- [x] A February 28 window resolves to February 29 in a leap year
- [x] Mid-year hire, both prorated and not
- [x] Accrual stops at `maxBalanceMinutes` and resumes after the balance drops
- [x] **26 periods of a 7200-minute allotment sum to exactly 7200** — the remainder case that silently shorts employees if it's wrong
- [x] A skipped period is caught up by the next run, not lost
- [x] Terminated employee accrues nothing after their termination date
- [x] A benefit year that isn't the calendar year (July 1 start)

**Done when:** a seeded year of accruals produces balances you've verified by hand against a spreadsheet.

*Verified on 2026-10-07 against the confirmed allotments, on a clean database,
running the jobs for every date they would actually have fired on:*

| | PTO end of 2026 | PTO 1 Jan 2027 | Cap applied |
|---|---|---|---|
| Whitfield, full-time (480/day) | 5280 (11 days) | **7680** = 2400 carried + 5280 granted | 5 × 480 = 2400 |
| Moreau, part-time (240/day) | 5280, granted 22 Dec — hire date plus 120 days | **6480** = 1200 carried + 5280 granted | 5 × 240 = **1200** |
| Reyes, terminated May 2026 | 5280 | 5280 — keeps the January grant, accrues nothing after | — |

*Not 12960 and not 11760: the forfeit-then-regrant pair holds. Sick, under a
120-day cap nobody reaches, accumulates 5760 → 11520 → 17280 across three
years. The part-timer carries five of her own days where full-time staff carry
five of theirs, which is the whole point of `EMPLOYEE_DAYS`.*

> A first attempt at this ran the 2027 rollover *before* the December grant it
> depended on and produced 10560 for Moreau — the stale-rollover hazard in
> point 6 below, in the wild. The jobs are daily and chronological in
> production, so it cannot arise there, but a backfill can reach it.

**Bugs found while building this, all fixed and pinned by tests.** Worth
reading before changing the rollover — most of them are the same shape, two
things touching the same minutes on the same date.

1. **The rollover forfeit ate the lot it had just created.** Both entries are
   dated day 1 of the new year, and the lot replay was ordering grants before
   consumption within a day — so the `FORFEIT` consumed the fresh
   `ROLLOVER_IN` (the soonest-expiring lot in the account) and left the old
   balance untouched and unexpiring. Carried December comp would never have run
   out. Fixed by ordering forfeits first within a day.
2. **`?date=2026-02-30` ran the job for March 2.** The shape check passed and
   `new Date()` rolled the day over silently. The parse now has to round-trip.
3. **A lot expiring on the old year's last day gave a different answer
   depending on which job ran first.** `expire-lots` dates its forfeit at
   `expiresOn + 1`, which is the same day the rollover writes — so one order
   forfeited the minutes twice and the other carried expired time forward as a
   fresh, non-expiring entry. The rollover now subtracts what an expiry has
   already taken, and refuses to carry a lot that has expired. Either order
   lands on the same balance.
4. **A carryover window with `usableUntilYearOffset: 0` crashed the whole
   rollover.** It resolves to an expiry inside the year that just closed —
   before the carried entry's own effective date — which the ledger's
   expiry-after-effective CHECK rejects, aborting the loop and leaving every
   employee after it with no rollover on the one day a year it runs. Such a
   window now rescues nothing, and the job collects per-employee failures and
   fails at the end rather than at the first one.
5. **An admin could give an hourly employee comp time as an `ADJUSTMENT`.** The
   database trigger only fires on `COMP_EARNED`, so the manual path went round
   rule 4. `createAdjustment` now checks `accruableBy`, and the form does not
   offer the type.
6. **A re-run of the rollover after a backfilled accrual silently did
   nothing.** `skipDuplicates` drops the recomputed rows, so the extra minutes
   are neither forfeited nor carried and the run reports `entriesCreated: 0`
   exactly as a healthy no-op does. The ledger is append-only so this cannot be
   auto-corrected; the job now counts the discrepancy as
   `rolloversNeedingCorrection` in its `JobRun` detail for an administrator to
   settle with an `ADJUSTMENT`.

## Phase 4 — Leave requests & approvals ✅

- [x] Request form with a per-day increment picker (Half day / Full day) and a projected-balance preview — holidays excluded, days outside the new `workWeekDays` setting defaulting to none
- [x] Increment validation: each day a positive multiple of the org increment, plus the stranded-balance exception — in the Zod schema *and* the service (rule 6)
- [x] Balance validation at submit and again at final approval, against a *projected* balance (`projectEntries()`) that includes future accruals, rollovers, expiries and other pending requests
- [x] Chain snapshot into `ApprovalStep` at submission
- [x] Sequential approval advance, deny-ends-it, self-approval skip, empty-chain-to-admins
- [x] `USAGE` entries written on final approval; `USAGE_REVERSAL` on cancellation
- [x] Admin override: approve, skip, reroute — each with a required reason
- [x] Approver inbox (`/approvals`, with a count in the header) and an administrators' queue (`/admin/requests`)
- [x] Database guarantees: positive day minutes, resolved-at matches status, decided steps record when, and a trigger refusing any self-decided step

**Done when:** a request moves end to end through a three-step chain and moves the balance correctly.
*Done — `tests/integration/requests.test.ts`, "moves a request end to end", and
the same flow through the browser in `tests/e2e/requests.spec.ts`.*

Tests: a 3-hour request is rejected at a 240-minute increment; a 180-minute request is accepted when that's the entire remaining balance; changing the org increment to 480 immediately invalidates half-day submissions without touching existing records. *All three are in the integration suite, along with denial, double-click on the final approval, the second balance check, pending holds, a request that would starve later approved leave, cancellation and reversal, and every override.*

**Judgement calls worth knowing about** — each is in `docs/DECISIONS.md`:

- Balance checks use the projection, so an employee can book against accrual
  they have not earned yet, assuming their current policy continues.
- A cancelled day in an already-closed benefit year is given back on the
  current year's first day, not on its own date, so it cannot slip past a
  rollover cap. Only an administrator can reach this case.
- Nobody decides their own request by any route. An administrator with an
  empty chain needs another administrator.
- Employees may cancel approved leave only before it starts; an administrator
  can cancel any pending or approved request, with a reason.
- Approver comments are optional, including on a denial. Override reasons are
  required.

Not done, deliberately: notifications (Phase 8 — the inbox is the only signal
for now) and `DRAFT` requests (in the enum, never created).

## Phase 5 — Employee experience ✅

- [x] Dashboard: balances, booked and pending time, next accrual, upcoming time off, and a forfeit warning — all read off `projectEntries()`, so it cannot disagree with the request form
- [x] History heatmap (GitHub-contribution style, colored by leave type, one benefit year per grid, scheduled leave drawn hollow) + table filterable by year and type
- [x] My requests filterable by status and type, with a dot per approval step and who it is waiting on; the dashboard links into the filtered views
- [x] Responsive layout verified at phone width — the request lists become cards below the small breakpoint, and an end-to-end test checks every employee page at 360px for sideways scrolling

**Done when:** a non-admin can do everything they need without an admin's help.
*Done — `tests/e2e/employee.spec.ts` follows a request from submission through
the filtered list, both approvals, the dashboard and the history, to its
cancellation leaving the history again.*

**Judgement calls worth knowing about** — each is in `docs/DECISIONS.md`:

- Today's balance on the dashboard includes what today's jobs will write but
  have not yet, exactly as the request form counts it.
- The forfeit warning has no lead time: any fixed number of days would be a
  policy number in code. It shows the next projected loss within a year, net
  of leave already approved, and ignores pending requests.
- History is read from approved request days, not the ledger, so a
  closed-year reversal cannot paint a phantom day on 1 January. Leave recorded
  only as an administrator's adjustment does not appear in the heatmap.
- Filters are plain links; a value that does not parse is ignored.

## Phase 6 — Comp time ✅

- [x] Overtime log form, gated to `SALARIED_EXEMPT` in the service layer and by DB constraint — a trigger on insert and on approval, behind the ledger's existing `COMP_EARNED` trigger
- [x] Routes through the standard approval chain — the same snapshot, advance, self-skip and overrides as leave, through `lib/requests/chain.ts`
- [x] `COMP_EARNED` on approval, at the org multiplier, into the leave type named by the new `compLeaveTypeId` setting
- [x] Optional expiry — `compExpiresAfterDays` stamps the entry and the existing `expire-lots` job forfeits it; unset at the church
- [x] Test: an hourly employee cannot create an overtime log or a `COMP_EARNED` entry by any route

**Done when:** a salaried employee can bank overtime and spend it as leave.
*Done — `tests/integration/overtime.test.ts` banks a log through a two-step
chain and then books it as leave; `tests/e2e/overtime.spec.ts` does the same
through the browser.*

**Judgement calls worth knowing about** — each is in `docs/DECISIONS.md`:

- Comp is dated on the day worked, so the December window keys on when the
  time was worked, not when it was signed off.
- **A log approved after its benefit year closed banks only what that year's
  rollover would have kept**, found by running the rollover with and without
  it. December overtime approved in January arrives with its February expiry;
  November overtime approved in January banks nothing. The approver sees the
  figure before deciding.
- A multiplier's half-minute rounds up, in the employee's favour.
- Pending logs can be withdrawn; approved ones are corrected by an
  administrator's adjustment, not cancelled.
- Logs reach back to the start of the previous benefit year and no further;
  one pending or approved log per day.

## Phase 7 — Timesheets ✅

- [x] Auto-create per employee per open pay period — the daily `create-timesheets` job, idempotent on `(employeeId, payPeriodId)`
- [x] Daily entry grid in the timesheet increment, approved leave and holidays prefilled and read-only — live while open, frozen at submission
- [x] Weekly overtime flagging — computed per workweek from time worked, on the day the threshold is crossed, across the pay-period boundary
- [x] Submit → approval chain → lock, with send-back, resubmission and withdrawal; a trigger refuses edits to a submitted or approved timesheet
- [x] Status grid per pay period (`/reports/timesheets`) with due dates and late/overdue marks, and unlock with a reason (audit-logged)
- [x] Exports: one employee's CSV (a row per day, then totals), a summary CSV, or every employee's CSV at once as a .zip
- [x] A `FINANCE` role that reads every timesheet and downloads the exports, and changes nothing (since replaced by access roles: Finance is a role holding the report permissions)
- [x] Due date as a setting — 3 days after the period ends, the Tuesday after a Sunday-to-Saturday period; late timesheets accepted and marked
- [x] Pay-period sync leaves any period with timesheets alone

**Done when:** an hourly employee can complete a full pay period and an admin can export it.
*Done — `tests/e2e/timesheets.spec.ts` fills in, corrects and submits a
timesheet, approves it, finds it in the status grid and the CSV, and unlocks
it; `tests/integration/timesheets.test.ts` covers the job, the freeze, a
rejection and resubmission, the database refusals, and overtime across two
timesheets.*

**Judgement calls worth knowing about** — each is in `docs/DECISIONS.md`:

- Overtime is never entered. It is the time worked beyond the weekly
  threshold, assigned to the day the threshold is crossed, so a week that
  straddles two pay periods never changes the earlier timesheet. Leave and
  holidays do not count toward it. There is no `OVERTIME` category.
- The workweek's first day is a new setting, `workweekStartDay`, seeded
  Sunday and still to confirm.
- A rejection sends the timesheet back to the employee rather than ending it.
- No `isLocked` column: approved *is* locked.
- A holiday is paid at the employee's own day, capped at the holiday's hours.
- Exports are hours to two decimals with the exact minutes alongside; the
  summary lists everyone due a timesheet, missing and unapproved ones included.
  **The format finance needs is still to be confirmed.**
- Finance is a third role rather than a permission flag; every write path
  already checks for `ADMIN`, so it gains nothing it should not.
- Lateness is judged by the first submission, so a correction is not late.

Not done, deliberately: `PayPeriod.isLocked` is still never set (a Phase 9
payroll question), and leave approved after a timesheet is submitted reaches it
only when it is reopened.

## Phase 8 — Notifications & reporting ✅

**Decided by the owner, 2026-10-07 — built to these:**

- **Push is every organization's default channel**: Web Push to the browser
  (a service worker and VAPID keys) **plus an in-app notification list**, so
  nothing is lost when someone blocks push. iOS delivers Web Push only once
  the site is added to the home screen (iOS 16.4+); say so in the UI.
- **Email is opt-in per organization**: sent only from an address an
  administrator gives TimeHero, as a setting — a new `OrgSettings` column, not
  just the `MAIL_FROM` environment variable. **No address set, no email at
  all.** Credentials stay with the operator: Graph uses the Entra app (only
  the address is needed); SMTP keeps its connection URL in the environment.
- **This church sends only from its own shared mailbox**, through Graph.
- **Emailed sign-in links need that address.** With none set, hide "Email me
  a sign-in link" on the sign-in page and refuse requests for one; the
  Microsoft and Google buttons remain. (`AUTH_EMAIL_LINKS` and
  `lib/sign-in-links.ts` today assume mail is available whenever the flag is
  on.)
- The church's staff get push **and** email, each choosing per notification
  type (confirmed before building).
- **Escalation, from the church's current Power Automate flow:** approvers
  are notified once when a request is submitted, then once a day after 7 days
  waiting, then every 4 hours after a further 3 days. The 7 days, 3 days, 1
  day and 4 hours are policy: `OrgSettings` columns, editable in Settings
  (rule 1). Applies to leave requests, overtime and timesheets alike.
- Timesheet reminders: the spec's "due" reminder lead time (2 days) is a
  setting too; "overdue" uses the existing due date.

- *Confirmed by the owner before building, 2026-10-07:* each person chooses
  push and email **per notification type**; the approver digest replaces
  **email only**; the church's configuration sets its mailbox.

- [x] Sending address as an admin setting (`OrgSettings.mailFromAddress`, under **Administration → Notifications**); no email at all without one; the sign-in page offers an emailed link only when there is one, and the request is refused server-side too. `MAIL_FROM` is gone from the environment
- [x] Web Push (`public/sw.js`, VAPID keys in the environment, a subscription per browser, a test button) and an in-app list at `/notifications`, with an unread count in the header and a manifest so iOS can add it to the home screen
- [x] The five notification types (SPEC "Notifications"), each toggleable org-wide; each employee chooses push and email per type
- [x] Escalating reminders for anything waiting on an approver — leave, overtime and timesheets — in the hourly `send-notifications` job, intervals as settings
- [x] Approver daily digest option, at a set hour, replacing approval email only
- [x] Timesheet due and overdue reminders; the due reminder's lead time is a setting
- [x] Year-end rollover summary to administrators
- [x] Reports under `/reports`: balances as of a date, leave taken, forfeitures, per-employee ledger with running balances
- [x] CSV export on every report (`/reports/export`)

**Done when:** an approver hears about a request without opening the app, and
finance can export every figure the spec lists.
*Done — `tests/e2e/notifications.spec.ts` submits a request and finds the
approver's email (from the sending address) and their in-app notification, clears
the sending address and sees emailed sign-in disappear, saves an employee's
choices, and downloads every report as finance;
`tests/integration/notifications.test.ts` covers who is told at each step of
the chain, every channel rule, push and email delivery with retries, the
escalation slots, the digest and timesheet reminders — each sent once however
often the sweep runs.*

**Judgement calls worth knowing about** — each is in `docs/DECISIONS.md`:

- A notification is a row written in the same transaction as the change it
  announces; push and email are delivered after commit and retried hourly.
- Push is owed only to someone with a subscribed browser.
- Reminders are named slots in the notification's unique key, so the sweep
  can run any number of times. A sweep that misses slots sends only the
  current one.
- Timesheet reminders go only for timesheets never submitted, and the job
  looks back a week past a due date at most.
- The rollover summary is sent even when some employees failed.
- Leave taken is read from approved request days, like the history page;
  balances "as of" a future date show what is recorded, not the projection.

Not done, deliberately: **quiet hours** (a reminder can arrive at night — to
confirm with the church), notifying an approver when a request waiting on
them is **cancelled** (not in the spec; it simply leaves their inbox), and
any test against **real** Graph mail or a real push service — the push sender
is mocked in the tests and Graph has no tenant to try.

Still open from Phase 7: **the CSV format finance needs** for payroll (the
current exports are a reasonable default), and the items the church still has
to confirm.

## Sign-in without Microsoft 365 — for the open-source release

*Decided and built 2026-10-07; design and remaining work in `docs/AUTH-PLAN.md`.*

- [x] `Identity` table replacing `Employee.entraOid`, migrated — done before Phase 9 loads real employees
- [x] Google sign-in alongside Microsoft
- [x] Passwordless emailed links: hashed single-use tokens, rate limits, a button rather than sign-in on open
- [x] Pluggable outgoing mail — Graph, SMTP, and files for development
- [x] Link by email only within the organization's tenant or domains; refuse a multi-tenant app with no directory
- [x] **Connect Microsoft 365** by admin consent; import and link staff, daily `sync-directory`, review queue
- [x] Pay schedule and leave policies settable on an employee's page (needed to review imports)
- [x] MIT licence
- [ ] Verify against a real tenant once the Entra registration exists — the Graph calls are tested with fakes only
- [ ] Google Workspace as a directory (import and create-at-sign-in) — planned in `docs/AUTH-PLAN.md`
- [ ] Generic OpenID Connect provider (Okta, Keycloak…)
- [x] The organization's starting configuration is a file (`prisma/config/`, `docs/CONFIGURATION.md`); the shipped example is a fictional organization with generic figures
- [x] `npm run setup`: an organization's configuration and a first administrator, no demo data
- [x] Self-hosting with Docker (`Dockerfile`, `docker-compose.yml`, `docs/SELF-HOSTING.md`), built and smoke-tested in CI; Azure as one worked example
- [x] Install docs that do not assume Microsoft 365; `CONTRIBUTING.md`, `SECURITY.md`
- [ ] Publish the public copy from one fresh commit, without the original organization's private files

## Phase 9 — Production

**Decided by the owner, 2026-10-07 — build to these:**

- **Someone else owns the church's Azure subscription.** Write a request for
  them, the way `docs/ENTRA-SETUP.md` asks the tenant owner for the Entra
  registration, and build everything that does not need access to the
  subscription.
- **Infrastructure as code: Bicep in the repo** (`infra/`): App Service,
  PostgreSQL Flexible Server, Key Vault and the identities between them,
  parameterized so another organization can deploy its own copy after the
  open-source release.
- **Ledger entries record the `JobRun` that wrote them** — a nullable
  `jobRunId`, set by every job, added *before* real employees and opening
  balances are loaded, because it cannot be backfilled. This is what Phase
  10's "reverse a job run" needs.
- **The production address is configuration, not code.** The church's will
  be a subdomain of its own; document how another organization sets its own
  (`APP_URL`, the App Service custom domain and certificate, the DNS record,
  and the Entra and Google redirect URIs that must match it).

**Built — needs nothing from the subscription:**

- [x] `LedgerEntry.jobRunId`, set by every job (migration `20261009000000_ledger_job_run`)
- [x] Infrastructure as code: `infra/main.bicep` — App Service (Linux, Node 22), Postgres
      Flexible Server firewalled to the app (TLS only; the decision is in DECISIONS.md),
      Key Vault references, a federated deploy identity, Application Insights, an optional
      custom domain with a managed certificate; `example.bicepparam` and the church's own parameter file.
      Compiles clean with Bicep 0.48; not yet deployed
- [x] Deploy on merge to `main` — `.github/workflows/deploy.yml`: build the standalone
      bundle, migrate through a temporary firewall rule, deploy, smoke test. Skips until
      the Azure variables exist
- [x] Health checks: `/api/health` (App Service's health check) and `/api/health/jobs`
- [x] **Missed-run detection** — Admin → Jobs flags any job past its cadence's grace
      period; `/api/health/jobs` returns 503 and an availability test emails the alert list
- [x] One-time import — `scripts/import.ts`: employees (policies, department, schedule,
      chain) and opening balances as this year's grants plus one keyed `ADJUSTMENT`, so the
      next accrual run grants nothing twice. Dry run by default; re-runnable
- [x] Production seed: `SEED_CONFIGURATION_ONLY=true`, requiring `SEED_PAY_ANCHOR_DATE`
- [x] **Restore drill** written — `scripts/restore-check.ts` fingerprints a database as of
      a moment; `docs/RUNBOOK.md` has the drill
- [x] `docs/AZURE-SETUP.md` (the request to the subscription owner, deploying, the
      production address for any organization), `docs/GO-LIVE.md`, `docs/RUNBOOK.md`

**Waiting on the church — in `docs/GO-LIVE.md` order:**

- [ ] Resource group and access — send Part 1 of `docs/AZURE-SETUP.md`
- [ ] Entra registration (`docs/ENTRA-SETUP.md`) — the app will not start in production
      without a way to sign in
- [ ] Pay schedule anchor date — required by the production seed
- [ ] Azure App Service + Azure Postgres provisioned (`az deployment group create`)
- [ ] Secrets in Key Vault, including the production VAPID key pair, generated once and
      never rotated casually (a new pair orphans every browser subscription)
- [ ] GitHub `production` environment and variables; `APP_BASE_URL` and `JOBS_SECRET`
      switch the scheduled jobs on, with no workflow change
- [ ] Restore drill performed and recorded in `docs/RUNBOOK.md`
- [ ] Real employees and opening balances loaded with `scripts/import.ts`, reconciled
      against the old system on Reports → Balances
- [ ] Parallel-run one pay period against the current process before cutting over
- [ ] First real notifications: a test push to a phone from `/notifications`, and an approval email arriving from the sending address through Graph
- [ ] Custom domain — DNS records, then `customDomain` in the parameters

**Done when:** a pay period closes correctly in production with no manual intervention.

> Two items from Phase 10 were brought forward into this phase: **missed-run
> detection** and the **restore drill**. A cron that silently stops is the
> failure most likely to go unnoticed for a year, and a backup nobody has
> restored is not a backup.

## Administrator overrides ✅

Added between Phases 9 and 10, before go-live, so an unusual case is handled
in the screen made for it rather than by a ledger workaround. Every one needs
a reason, is audit-logged, and is refused on the administrator's own records.

- [x] Enter leave for an employee — through their approval chain, or recorded
      as already approved; optionally allowed to overdraw (Admin → Employees →
      Record leave)
- [x] Amend a pending or approved request: days, amounts, leave type
- [x] Deny a request on an approver's behalf
- [x] Cancel approved overtime, taking back the comp it banked
- [x] Fill in and submit someone else's timesheet
- [x] Edit leave types, leave policies, pay schedules and carryover windows
      that already exist
- [x] Edit a policy assignment's dates and allotment override in place

Not done, deliberately: waiving the minimum increment (rule 6 is
non-negotiable), editing holidays (delete and add again), and overriding
anything on one's own records.

## Phase 10 — Reconciliation and rollback

*Idea captured 2026-10-07, not yet designed in detail.*

Everything up to here assumes the engine is right. This phase assumes it
eventually won't be, and asks two questions: **how would we find out**, and
**how would we undo it**.

The ledger makes both tractable and both unusual. Because entries are
append-only and every balance is derived, a bad run is never silently absorbed
into a stored total — it is a set of rows with a known `periodKey`, and the
correct state is always recomputable from policy. But for the same reason,
nothing can be rolled back by deleting it.

### The reconciliation job — "does the ledger still agree with policy?"

A read-only job on a slow cadence (nightly, or weekly) that recomputes what the
engine *believes* should exist and diffs it against what is actually there. It
reports; it never writes a ledger entry. Auto-correcting a ledger is how one
bug becomes ten thousand rows nobody can interpret.

Checks worth having, roughly in order of how badly they would hurt:

- [ ] **Missed runs.** Is there a `JobRun` for every date each job should have
      fired on? A cron that stops silently is the worst failure in the system:
      balances simply stop moving, and the first symptom is an angry employee
      in December. This check is worth building before any of the others, and
      it needs nothing from the ledger.
- [ ] **Recompute and diff.** For every employee and leave type, run the engine
      over the current benefit year and compare its proposed entries against
      the ones on record. A difference means policy changed under a written
      entry, a job ran against stale configuration, or the engine has a bug.
      Report the delta per employee; never post it.
- [ ] **Negative balances** on a type where `allowsNegativeBalance` is false.
- [ ] **Lots versus balance.** `sum(lot remainders)` should equal the balance
      wherever nothing is overdrawn. A divergence means the replay and the
      aggregate disagree — the two halves of the design drifting apart.
- [ ] **Expiry backlog.** Lots past `expiresOn` with a remainder and no
      `FORFEIT`, which means `expire-lots` has not been running.
- [ ] **Stale rollovers.** `rolloversNeedingCorrection` is already counted per
      run; this surfaces the accumulated total rather than leaving it in one
      morning's `JobRun`.
- [ ] **Constraint drift.** Comp entries against non-exempt employees, entries
      on an inactive leave type, entries dated implausibly far ahead,
      assignments overlapping for one leave type on one date.
- [ ] Output as an admin report and — once Phase 8 exists — a digest to the
      administrators, with a clean run saying so rather than staying silent. A
      monitor that only speaks up when it is unhappy is indistinguishable from
      a monitor that has died.

### Rollback

Three different things get called rollback, and they need three different
answers:

- [ ] **Reversing a job run.** Post the exact negation of every entry a given
      `JobRun` created, as `ADJUSTMENT` rows that reference it, in one
      transaction. The original entries stay — that is the point — so the
      history reads "granted, then reversed on this date because of this", not
      a gap. Then fix the cause and re-run the job, which the idempotency keys
      make safe.
      > **Prerequisite:** entries do not currently record which run wrote
      > them. `sourceType`/`sourceId` point at the `LeavePolicy`. Reversal
      > needs them to point at the `JobRun`, or needs a third field. Worth
      > deciding before Phase 9 loads real data, because it cannot be
      > backfilled onto rows already written.
- [ ] **Reversing a deploy.** App Service slot swap, or redeploy the previous
      image. Independent of the data, and the easy case.
- [ ] **Reversing a migration.** Prisma has no down-migrations, so the answer
      is a forward migration or a restore from backup. Whichever it is, write
      it down — the moment it is needed is the worst moment to be deciding.
- [ ] **Restoring the database.** The ledger is append-only and derived, so a
      point-in-time restore plus a re-run of the jobs from that date should
      reproduce the same balances exactly. That property is worth *testing*,
      because if it holds, restore stops being frightening.

### Why this is cheap here and expensive elsewhere

A system with a mutable `balance` column cannot do most of the above: there is
no way to recompute what the number should have been, and no way to reverse a
change without knowing what it overwrote. The ledger already pays for that
(see "Immutable ledger, no balance column" in `docs/DECISIONS.md`); this phase
is mostly collecting the benefit.

**Done when:** a deliberately broken job — a wrong allotment, a skipped
rollover, a cron switched off — is caught by the reconciliation report rather
than by an employee, and can be reversed without editing a single row.

## Access roles and managers from the directory ✅

- [x] Permissions (`lib/permissions.ts`) in place of the fixed roles; every
      guard asks for one. Administrators bundle them into access roles under
      Administration → Access. Administrator holds everything; Finance holds
      the five reports. Nobody changes their own access, nobody edits someone
      who holds more, and someone who can sign in always manages access.
- [x] The directory sync reads each person's Entra manager, starts an empty
      approval chain with them, and flags a later change for review.
- [x] An account deleted from the directory is treated as disabled: the
      employee is flagged and blocked from every way of signing in.
- [ ] Drop `employees.role` once a release without it has shipped.

## Deferred

Payroll integration beyond CSV, FMLA tracking, Entra group → role sync, shift scheduling, native mobile, multi-campus scoping.
