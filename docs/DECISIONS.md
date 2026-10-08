# Decisions

Why the stack looks the way it does. Add an entry when you change something structural.

## Next.js full-stack, not a separate API + SPA

One repo, one deploy, one set of types shared between server and client. A separate backend would double the deployment surface for an app with no second consumer. Server Actions remove most of the hand-written API layer.

**Cost:** you're tied to the Next.js release cycle, and Server Actions are less familiar than REST if a contractor ever picks this up.

## PostgreSQL over SQL Server

Azure Database for PostgreSQL Flexible Server is substantially cheaper than Azure SQL at this scale, and Prisma's Postgres support is its best-tested path. There's no existing SQL Server dependency to match.

## Prisma over Drizzle

Prisma has more documentation and training data behind it, which matters directly when Claude Code is the primary maintainer. Its migration workflow is also harder to get wrong. Drizzle is faster and more SQL-transparent, but that's not the binding constraint here.

## Auth.js with external accounts and emailed links, no local passwords

Staff already have M365 accounts. Offboarding then happens in one place: disable the Entra account and access ends. Storing a password hash would create a credential to leak for no benefit.

*Revised 2026-10-07 for the open-source release:* Google sign-in and passwordless emailed links sit alongside Microsoft, so an organization without Microsoft 365 can use TimeHero. Still no passwords — an emailed link gives the same reach with nothing to steal. `docs/AUTH-PLAN.md` has the design.

**Consequence:** test and seed data needs a documented local bypass that is hard-disabled in production.

## Immutable ledger, no balance column

This is the single most important decision in the system. A mutable balance can't answer "why is my PTO wrong?", and a bug silently corrupts state forever. With a ledger, every number is reconstructible and every mistake is a visible correcting entry.

**Cost:** balance reads are a `SUM` instead of a column read. At ~100 employees that is nothing; `BalanceSnapshot` exists as an escape hatch if it ever becomes something.

## Durations stored as integer minutes

Minutes as `Int`, never hours as `Decimal` or `Float`. Integers can't drift, sum exactly, and compare safely with `=`. Decimal hours would invite `0.5`-style arithmetic and float contamination the first time someone writes `hours / 2`. Minutes are also fine enough for any increment the church might later adopt — quarter-hour, hourly, half-day — without a migration.

Hours and half-days are produced by `formatDuration()` at the render edge. No stored value is ever a formatted one.

**Cost:** every read path needs the formatter, and raw DB rows are less readable during debugging. Worth it.

## Configurable minimum increment, with accrual exempt

The church takes leave in half-days, but that's policy, not physics, so it's `OrgSettings.minimumRequestIncrementMinutes` (240) rather than a constant. A future board decision to allow hourly leave is then a settings change.

The important subtlety: the increment constrains **requests**, not **accruals**. A per-pay-period policy grants odd amounts like 277 minutes, and rounding those to a 240-minute boundary would cost employees real time every period. Timesheets get a separate 15-minute increment, because hours actually worked aren't a half-day concept and rounding them would make payroll wrong.

**Stranded balances** are the non-obvious failure here: at a 240-minute increment, a 180-minute balance can never be spent and sits on the books forever. Hence `allowSubIncrementWhenBalanceIsLower`, which permits a final request equal to the exact remaining balance. Default on; an admin who prefers the stricter rule can turn it off.

## Cumulative-target accrual instead of per-period division

`annualMinutes / periodsPerYear` doesn't divide evenly (7200 over 26 periods = 276.92). Rounding each period independently overshoots or undershoots the annual allotment by the accumulated error.

Each grant is instead the difference between a cumulative target and what's already been granted this benefit year. Grants alternate 277/276, the running total is never off by more than a minute, and the year-end sum is exactly the allotment. It also self-corrects: a skipped or late period is caught up by the next run rather than lost.

## Policy as data, with current values in one file

The person who understands this policy may not be here when it changes. So no church-specific number lives in code: the 120-day waiting period, the 5-day PTO rollover, and the December comp window are all rows an admin can edit. The organization's configuration file (`docs/CONFIGURATION.md`) records the starting values in one place, so a successor can see what was configured without reading the database or the source.

The test of this is whether a board decision — extend the comp grace period to March, raise rollover to 10 days, switch to a fiscal year — can be implemented by an administrator in the UI. All three can.

**Cost:** more tables and more admin screens than hardcoding would need. That's the price of the thing outliving its author.

## One formula for the lump grant date

"Full allotment on January 1, or 120 days after your start date" reads like two rules, and implementing it as two invites the November-hire bug: someone whose waiting period ends in March gets a January 1 grant they haven't earned, or two grants, or none.

`max(benefitYearStart, hireDate + waitingPeriodDays)`, capped at one grant per benefit year, handles every case with no branching. A November 1 hire's grant date lands in March of the following year, so the hire year produces nothing and the next year's single grant is correctly dated March 1.

## Lot tracking for expiring time

The December comp rule needs the system to know how much of a *specific* grant remains unspent. A running balance can't answer that — if someone banked 16h in December, spent 8h in January, and earned 4h in February, the balance says 12h but only 8h of it expires.

So grants carry an optional `expiresOn`, and `lotBalances()` replays the ledger to find each grant's unconsumed remainder. Crucially this stays off the hot path: ordinary balance reads are still a plain `SUM`, and only the rollover and expiry jobs pay for the replay.

**Consumption order is soonest-to-expire first**, not FIFO. Strict FIFO would spend permanent PTO while a February-expiring comp lot ran out — technically defensible, and employees would rightly consider it theft.

## Rollover zeroes out before it re-grants

Worth stating because the obvious implementation is wrong. A balance is a cumulative `SUM` over all entries, so it already carries into the new year on its own. Rollover's job is to *remove* what isn't kept.

Writing a `ROLLOVER_IN` for the carried amount without first forfeiting the full closing balance doubles everyone's time. The sequence is forfeit `−B`, then grant `+carry`, in one transaction. It also reads better in an employee's history — "200 forfeited, 40 carried" rather than a bare `−160` nobody can interpret.

An earlier draft of the spec had exactly this bug. It's now a required test.

## Rollover caps in days, not minutes

"5 rollover days" has to mean five of *that employee's* days. A fixed 2400-minute cap would hand a part-timer on a 4-hour day ten days of rollover while full-time staff got five. The `EMPLOYEE_DAYS` cap basis multiplies by `standardMinutesPerDay`; `FIXED_MINUTES` remains available for policies genuinely expressed in hours.

## Idempotency keys on accrual

Scheduled jobs retry. Networks fail mid-run. Without `(employeeId, leaveTypeId, kind, periodKey)` being unique, a retried job double-grants PTO and nobody notices until year-end. The unique index makes correctness a database guarantee rather than a careful-coding one.

## GitHub Actions cron over Azure Functions

The jobs are a handful of HTTP calls on a schedule. A separate Functions app means a second deployment target, a second runtime to patch, and a second place to look when something didn't run. A scheduled workflow hitting an authenticated route keeps everything in one repo with its logs beside the deploy logs.

**Cost:** GitHub's scheduled triggers can run late under load, and all jobs are designed to tolerate that. If timing ever has to be exact, move to an Azure Container Apps job — the job routes don't change.

## Microsoft Graph for email, not SendGrid

The M365 tenant already sends mail, mail from the church's own domain won't land in spam, and it removes a vendor, a bill, and an API key.

## Comp time restricted to exempt employees

Under the FLSA, private-sector employers can't give non-exempt employees comp time in lieu of overtime pay — that's a public-agency provision. Salaried exempt staff aren't owed overtime at all, so discretionary comp time for them is a policy choice the church is free to make. The restriction is enforced in code because getting it wrong is a wage-and-hour liability, not a bug.

Worth having whoever handles HR confirm the policy in writing before Phase 6 ships.

## Pay periods as stored rows, not computed on the fly

Computed periods shift retroactively the moment someone edits a schedule, which would silently re-date historical accruals. Stored rows mean history is fixed and a schedule change only touches future unlocked periods.

## Org-wide rollover caps

The spec calls for one cap per leave type for the whole organization, which keeps the admin UI to a single screen. If per-employee exceptions are ever needed, add a nullable override on `EmployeeLeavePolicy` rather than reworking `RolloverRule`.

## The ledger's invariants are database constraints, not conventions

The Phase 3 migration adds a CHECK that an `ADJUSTMENT` carries a reason, a CHECK that the sign of an entry matches its kind, a CHECK that an expiry cannot precede its grant, a trigger restricting `COMP_EARNED` to exempt employees, and a trigger refusing every `UPDATE` on `ledger_entries`.

All of them are enforced in the service layer too. The point of the duplication is that a constraint also holds for a psql session, a one-off import script, and whoever maintains this in 2031 — and the sign check in particular catches the entire family of rollover bugs where a forfeit is written positive and doubles someone's balance instead of clearing it.

`DELETE` is deliberately left alone. The only route to one is the foreign-key cascade from removing an employee outright, which is erasing a record rather than rewriting history. `UPDATE` has no legitimate caller at all.

**Cost:** two constraints to remember when the shape of an entry changes, and a trigger is invisible until it fires. Worth it for the one table where silent corruption would be unrecoverable.

## The engine is pure; only the service layer touches Prisma

Everything in `lib/accrual/` takes plain data and returns the ledger entries it believes should exist. It writes nothing, reads nothing, and imports no Prisma. `lib/ledger/` and `lib/jobs/` do the I/O.

That is what makes the hard parts testable against hand-checked figures: the November-hire grant date, the forfeit-then-regrant pair, the December comp window and the 26-periods-sum-to-7200 remainder are all unit tests with no database in the way. The integration suite then proves the same numbers survive the round trip.

**Cost:** the jobs have to assemble their inputs explicitly, and a few shapes are declared twice — once in `schema.prisma` and once in `lib/accrual/types.ts`.

## Idempotency is the unique index, not careful coding

Every job-written entry carries a `periodKey`, and writes go through `createMany({ skipDuplicates: true })`. A retry, a manual run during a scheduled one, or a backfill for a past date creates nothing twice because the database refuses it, not because the code remembered to check.

The period key is numbered from the start of the benefit year rather than from the employee's eligibility, so editing a waiting period cannot renumber keys already written and let a re-run grant the same period twice under a new name.

**Consequence:** an entry that may legitimately repeat — a manual adjustment — carries a null key. Postgres treats NULLs as distinct, so the same index leaves those alone with no partial-index clause.

## Jobs are reachable by cron and by an administrator

`POST /api/jobs/<name>` authenticates with a shared secret, which is how the GitHub Actions cron runs them. `/admin/jobs` runs the same job as an authenticated administrator. Both end in the same wrapper and write the same `JobRun`, so a hand-run and a scheduled run are indistinguishable afterwards.

The second path exists because GitHub's scheduled triggers can run late or be missed, and every job is built to be re-run for a past date. Without somewhere to type that date, recovering a missed run would mean a database console.

**Cost:** two authentication paths into the same code. They converge immediately, and the `JobRun` log records both identically.

## Accrual scope follows employment, not the `isActive` flag

`isActive` governs sign-in and carries no history — it says whether the account works *now*. `terminationDate` is the historical fact about employment. A job acting on a past date has to use the latter, or a backfill to January would skip everyone who has left since.

So a job processes employees who are active with no termination date, or who hold a termination date on or after the date being processed. Someone deactivated with no termination date is out, which is what an administrator pressing "deactivate" means.

## A request is checked against its projected balance

A request for next March is judged against next March's balance, which does not exist yet. Rather than approximate it, `projectEntries()` runs the engine's own functions forward a day at a time over a copy of the ledger — the pay periods that close, the lump grant, the rollover, the expiries — in the order the daily jobs would. The request and every other pending request go in as hypothetical `USAGE`, which matters: a rollover caps what is left *after* spending, and expiring comp is consumed before permanent time.

The check is "no usage date on or after the first requested day ends below zero", not "this request fits on its own dates". A request that is affordable in October but leaves an already-approved December day uncovered is refused now rather than discovered in December.

It runs twice, as the spec asks: at submission, and inside the final approval's transaction. Between the two the configuration may change or the time may be spent elsewhere; if the second check fails nothing is written and the approver is told to deny or have the balance corrected.

**Cost:** an employee can book against accrual they have not earned yet, on the assumption that their current policy continues. If it does not — a termination, a policy change — the final-approval check catches what it can, and anything already approved is an administrator's adjustment.

## Reversals are dated on the leave day, unless that year has closed

Cancelling approved leave writes `USAGE_REVERSAL` entries dated on the original days, so the balance on every date reads as though the leave had never been booked.

The exception is a day in a benefit year that has already rolled over. That rollover forfeited and carried the balance as it stood, and restoring time into the closed year now would raise its closing balance with no forfeit to match — time carried past the cap, the same shape as the stale-rollover problem in ROADMAP.md. Such a day is given back on the first day of the current benefit year instead, with a note saying so.

Only an administrator can reach this case: an employee may cancel approved leave only before it starts.

## Nobody decides their own request, by any route

The snapshot skips a requester who appears in their own chain. The service refuses an approval, denial, override or reroute by the requester, administrators included. A trigger on `approval_steps` refuses any decided step whose decider is the requester, so the rule also holds for a psql session.

**Consequence:** an administrator whose own chain is empty needs a *different* administrator to approve them. With a single administrator that request can never be approved — which is the correct answer, and the fix is to give them a chain.

## Every request operation locks the employee, then the request

Submission, every decision and cancellation take `SELECT … FOR UPDATE` on the requester's employee row, then on the request row, before reading anything they judge. The first serialises balance checks, so two requests submitted at once cannot both spend the last day. The second makes a double-click on "Approve" produce one decision and one "already decided", not two sets of `USAGE` — which matters because those entries carry no idempotency key. One order everywhere means two operations can never deadlock.

## The dashboard reads the projection, not just the ledger

Every figure on the dashboard comes from `projectEntries()` over the real ledger — the same engine run the request form's balance check uses — so the dashboard can never show time the form would then refuse. Today's balance includes anything today's jobs will write but have not yet written: on the morning of a benefit year's first day it already shows the new allotment, as the form does. "Next accrual" and "will be forfeited" read the projection a rolling year ahead and count only what lands *after* today.

Pending requests are left out of the forecast. They may yet be denied, so they neither hold back an accrual ceiling nor rescue time from a forfeit; the dashboard shows them as their own line instead.

## A forfeit warning has no lead time

The spec asks for a warning when an expiry is "approaching". Any fixed lead time — 30 days, 60 — would be a policy number in code (rule 1), and the right answer for carried comp with a two-month life is different from PTO over its cap. So the dashboard shows the next projected loss whenever there is one within the year it looks ahead: the rollover's forfeit net of what it carries, or a lot's expiry, both computed by netting `FORFEIT` against `ROLLOVER_IN` on the same date. The warning is net of approved leave already booked before the cutoff, which is what makes it actionable — it says how much is still unplanned.

If the church later wants a quieter dashboard, the lead time belongs in `OrgSettings`.

## History is read from approved requests, not from the ledger

The ledger's `USAGE` rows hold the same days, but a reversal is not always dated on the day it reverses — one from a closed benefit year lands on the current year's first day (above) — so netting the ledger by date would paint a phantom day on 1 January. Approved `LeaveRequestDay` rows have no such case: a cancelled request simply drops out. The cost is that an administrator's manual `ADJUSTMENT` recording leave taken outside the system does not appear in the heatmap; it is in the ledger, where an administrator looks.

## Filters are links, and a bad one is ignored

The request and history filters are plain links with query parameters, validated by Zod at the page. They work without JavaScript, every filtered view is a URL the dashboard can link to, and a value that does not parse is dropped rather than failing the page — a stale bookmark shows the whole list. Filters only ever narrow a query already scoped to the signed-in employee, so no parameter can widen what anyone sees.

## Overtime goes through the leave request's chain, not a second one

An overtime log snapshots the employee's approval chain at submission and moves through it with the same pure functions as a leave request (`snapshotChain`, `applyDecision`, `mayDecide`), with the same self-skip, empty-chain-to-administrators and override rules. `ApprovalStep` gained a nullable `overtimeLogId`, and its CHECK now requires exactly one subject across both. The service in `lib/overtime/` mirrors `lib/requests/service.ts` rather than sharing a generic one: the two differ in what they lock, what the final approval writes and what cancellation means, and a generic service would have hidden those differences behind parameters.

## Comp is banked on the day worked, at the multiplier in force at approval

The `COMP_EARNED` entry is dated on the day the overtime was worked, not the day it was approved, because that is what the December carryover window keys on: overtime worked on 29 November and approved on 2 December is November comp. The multiplier is read at final approval — that is when the spec says comp is "written at the org's multiplier" — and recorded on the log, so a later change to the setting does not make old logs unreadable.

Minutes at a multiplier round to the nearest minute, a half rounding up: 15 minutes at 1.5× is 23. The employee worked the time, so the odd half-minute goes their way.

## A log approved after its year has closed banks what the rollover would have kept

December overtime is routinely approved in January. Writing its `COMP_EARNED` into the closed year would raise that year's closing balance after the rollover had already run, with no forfeit to match — the stale-rollover hazard again, and for comp it would make November overtime permanent.

So the rollover is asked what it would have done: `planCompEarned()` runs `runRollover()` over the closed year twice, with and without the overtime, and banks the difference on the current year's first day with the expiry that carry would have had. December comp arrives with its February expiry; November comp banks nothing, and the log is approved with `earnedMinutes = 0`. The approver sees this on the log's page before deciding. Nothing reaches back through two rollovers, so a log can be submitted no earlier than the start of the previous benefit year.

**Cost:** an employee whose December overtime sat unapproved until March receives comp that has already expired, and the next `expire-lots` run forfeits it. That is the policy applied as written; the remedy for a slow approver is an administrator's adjustment.

## Approved overtime is not cancelled in the app

An employee or administrator can withdraw a pending log. Once approved, the comp may already have been spent, and reversing it could drive the balance negative; that is a judgement for an administrator, made as an `ADJUSTMENT` with a reason on `/admin/ledger`, not a button.

## Which type receives comp is a setting

`OrgSettings.compLeaveTypeId` names the leave type overtime is banked into, rather than the code looking for `COMP` (rule 1). It must be an active `EXEMPT_ONLY` type, checked when the setting is saved and again when a log is approved — an administrator later opening the type to hourly staff turns overtime logging off rather than breaking rule 4. Clearing the setting switches overtime logging off entirely.

## Comp expiry rides on `expire-lots`

The roadmap's "optional expiry job" needed no new job. `compExpiresAfterDays` stamps `expiresOn` on each `COMP_EARNED` entry, and the existing daily `expire-lots` already forfeits any lot past its expiry, soonest-to-expire first, with the same idempotency key. It is unset at the church, whose only comp expiry is the December window.

## Overtime on a timesheet is computed, not entered

The data model sketched an `OVERTIME` entry category. It was dropped: an employee choosing which of their hours are overtime lets the regular/overtime split disagree with the hours themselves, and FLSA leaves no choice to make. Overtime is derived from the worked (`REGULAR`) rows by `lib/timesheets/overtime.ts`, wherever a timesheet's figures are shown, approved or exported. Only time worked counts toward the weekly threshold; paid leave and holidays are not hours worked and do not.

## Overtime lands on the day the threshold is crossed

A workweek is fixed by the employer and need not line up with the pay period, so some weeks straddle two timesheets. Three ways to attribute that week's overtime were considered:

- **To the period the week ends in.** The earlier timesheet is submitted before the week is over, and if its days alone pass 40 hours, the later timesheet would have to report negative regular hours to reclassify them.
- **Recompute both when the later one is filled in.** An approved, exported timesheet would change after the fact.
- **Day by day, chronologically** (chosen). Each day's overtime is the part of it above the threshold, counting the week from its first day. A day's figure depends only on the days before it, so the earlier timesheet's numbers never move, nothing goes negative, and the two periods' overtime always sums to the week's.

The first workweek of a period therefore reads the previous timesheet's worked days to know where the week stands. If an administrator unlocks and edits that earlier timesheet, the later one's overtime changes too — correctly, since the week changed.

The day the workweek starts is a setting, `workweekStartDay` (rule 1), seeded as Sunday in the church's configuration and left for it to confirm.

## Leave and holidays are live until submission, then frozen

While a timesheet is open its leave and holiday lines are read from approved requests and the holiday calendar, so leave approved mid-period appears without anyone touching the timesheet. Submission writes them as `LEAVE` and `HOLIDAY` entries, and from then on those are what the page, the approvers and the export read. Leave approved for the period after submission does not reach the timesheet until it is opened again — by a withdrawal, a rejection or an unlock — which is the honest answer: the approver approved what they saw.

A holiday is paid at the calendar's hours but no more than the employee's own working day, so a part-timer on four-hour days is paid four hours. Whether that is the church's policy is in "Still to confirm".

## A timesheet is locked when it is approved, with no separate flag

The sketched `isLocked` column was left out. "Locked" is exactly `status = APPROVED`, and SUBMITTED is read-only too; a second column could only drift from the first. A trigger refuses any change to a submitted or approved timesheet's entries, so the lock holds against code that forgets to check.

A rejection ("Sent back" on screen) returns the timesheet to the employee rather than ending it, as a leave denial does: the hours were worked and still have to be paid. An administrator's unlock does the same for a submitted or approved one, needs a reason, is audit-logged, and is never available on one's own timesheet. Either way the old approval steps stay and the next submission numbers its steps after them, so the history reads top to bottom.

## A pay period with timesheets is never redrawn

Pay-period sync already left locked periods alone. It now also leaves any period that has a timesheet, locked or not — hours were entered against those dates — and the timesheet's foreign key to its period is `Restrict`, so a removal that slipped past the check would fail loudly rather than take the timesheets with it. `PayPeriod.isLocked` is unchanged and still unused: whether a period locks when every timesheet in it is approved is a Phase 9 payroll question.

## Exports: one CSV per employee, a summary, or all of them in a zip

Finance has not yet said what format their payroll system takes, so the exports aim to be easy to reshape rather than to match one importer. Each employee's timesheet is a CSV with a row for every day of the period — days with nothing on them included — then a TOTAL row. The summary has a row per employee due a timesheet, including anyone whose timesheet is missing or unapproved, with its status and whether it came in on time: payroll should see a gap, not a short file. "Download all" is a .zip of every employee's CSV plus the summary.

Figures are hours to two decimals, which is what payroll imports, with the exact minutes alongside, because minutes are what the system stores (rule 5) and a rounding question should be answerable from the file. Cells that start like a formula are prefixed with an apostrophe, since employees type the notes.

The zip is written by `lib/zip.ts`, about a hundred lines that store files uncompressed. A few kilobytes of CSV gain nothing from compression, and a dependency for it would be the first in the project with no other use.

## Finance is a role, and reads without writing

Payroll needs every timesheet without being able to change one. `FINANCE` is a third value of `Role`: a finance user is an ordinary employee (requests leave, appears in chains) who can also open `/reports` and download the exports. Every write path in the code checks for `ADMIN` specifically, so finance gets no settings, no overrides and no unlocks without any of those paths changing; `canReadReports()` in `lib/roles.ts` is the single place that grants the reading. Reports live under `/reports` rather than `/admin` so the admin layout's guard stays admin-only.

## Timesheets are due a set number of days after the period, and lateness is only shown

The church's periods run Sunday to the second Saturday and are due the following Tuesday, with exceptions. `timesheetDueDaysAfterPeriodEnd` (3) holds the offset (rule 1). Nothing refuses a late timesheet — exceptions are the norm — so lateness is a label in the report and on the page, not a rule. It is judged by the *first* submission, read from the earliest approval step: a timesheet sent back for a correction and resubmitted after the due date was still in on time.

## Linking by email only within the organization's own tenant or domains

Linking a Microsoft or Google account to an employee by email address is only as safe as the address. A multi-tenant Microsoft app accepts accounts from any tenant, whose administrators can put any address on an account; linking by it would let a stranger sign in as an employee. So with a directory registered, only accounts from its tenant (Microsoft) or Workspace domains (Google), with addresses in its verified domains, are linked; with none registered, a multi-tenant Microsoft app links nobody by email. A single-tenant app, as the church's will be, keeps the old behaviour of linking by exact address. The rules are one pure function, `decideExternalSignIn`, with a test per case.

## The directory adds people; it never decides their terms

A directory sync imports enabled member accounts and links existing employees, but everything a directory cannot know — hire date (unless HR set it in Entra), employment type, pay schedule, leave policies — is left at its safest value and the employee is marked for review: hourly (the opposite mistake could hand an hourly person comp time, rule 4), no schedule and no policies, so nothing accrues and no timesheet is made. A disabled account flags its employee rather than deactivating them, because leaving is an HR decision with a termination date. Saving the employee's record is the review.

## Emailed links are spent by a button, not by opening them

Mail security scanners open links in incoming messages. A link that signed in on a GET would be spent by the scanner, and the scanner — not the person — would hold the session. The link opens a page whose button posts the token. Tokens are hashed at rest, expire in 15 minutes, and are spent by a conditional update so a double click cannot use one twice. The request form answers identically for known and unknown addresses, and its rate limits count requests regardless of whether the address exists, so neither gives away who works there.

## Mail is one function with interchangeable transports

Phase 8 planned Microsoft Graph only. The open-source release needs SMTP, and emailed sign-in needed mail before Phase 8, so `sendMail()` chooses a transport from configuration: Graph from a shared mailbox (the church), SMTP via nodemailer (anyone else), or a file per message in development, which is also how the end-to-end tests read a sign-in link.

## A notification is a row first, written with the change it announces

Every notification is created inside the transaction that makes the change — the submission, the decision, the reroute — so a decision that rolls back announces nothing, and one that commits cannot lose its announcement. The row *is* the in-app list. Push and email are delivered from it afterwards: straight after the action's response has gone (`after()` in `lib/notifications/after.ts`), and again by the hourly `send-notifications` job, which retries anything that failed. Each channel of each row is claimed with a conditional update before it is sent, so two deliveries running at once cannot both send it; a claim abandoned by a crash is released after ten minutes, preferring a rare duplicate to a lost notification. Five failed tries mark the channel `FAILED`, and the admin Notifications page counts them.

## Email comes only from an address an administrator chose

Decided by the owner on 2026-10-07. The sending address is `OrgSettings.mailFromAddress`, not configuration; the `MAIL_FROM` environment variable is gone. With no address, `sendMail()` refuses and no email is created at all — not even queued — and "Email me a sign-in link" disappears from the sign-in page, its request refused server-side as well. How mail leaves (Graph or SMTP, and SMTP's credentials) stays with the operator in the environment, because an administrator setting a password in a web form is a secret in the database. The church's configuration sets its own mailbox; the example configuration sets none.

## Push is owed only where a browser has subscribed

Web Push (VAPID, through the `web-push` package — the payload encryption is RFC 8291 and not worth hand-rolling) is every organization's default channel, but a notification is only marked as owed by push when its recipient has at least one subscribed browser. Otherwise every notification for someone who never turned push on would sit "pending" for ever. A subscription the push service reports gone (404/410) is deleted. iOS delivers Web Push only to a site added to the home screen, so the app has a manifest and the opt-in says so on an iPhone.

## Each person chooses push and email per type; the organization chooses which types exist

Confirmed by the owner on 2026-10-07. A type switched off org-wide creates nothing for anyone. Otherwise each employee has a push and an email choice per type, defaulting to both — email only where the organization sends it. The preferences form carries the current value of any choice it is not showing (a type switched off, email when there is no address), so saving it cannot quietly turn off a channel that was merely not on offer.

## The approver digest replaces approval email, and only email

Confirmed by the owner on 2026-10-07. An approver who chooses the digest gets one email a day, at the org's `approverDigestHour`, listing everything waiting on them; the individual "waiting on you" emails and reminders are recorded as `DIGEST` and not sent. Push and the in-app list still arrive one at a time — the digest is about inbox volume, not about hearing late. Turning approval email off turns the digest off too. A digest is claimed by a unique `(employee, date)` row before it is sent, and the claim is released if sending fails, so the next hour retries.

## Reminders are named slots, so a sweep can run any number of times

Escalation follows the church's Power Automate flow — once on arrival, daily after 7 days, every 4 hours after a further 3 — with all four numbers as settings. Rather than asking "is a reminder due now?", which depends on when the last sweep ran, `reminderSlot()` names the slot the moment falls in (`daily-2`, `frequent-5`) and the slot is part of the notification's unique key. A sweep that runs twice sends nothing twice; one that misses several slots sends only the current one. The job runs hourly, so a four-hourly reminder lands within the hour. "Waiting since" is when the current step became current: the submission, or the previous step's decision. There are no quiet hours yet — a reminder can arrive at night; a possible later setting.

## Timesheet reminders: due from before the period ends, overdue once

The spec's "2 days before period close" is `timesheetReminderDaysBeforePeriodEnd`: an open, never-submitted timesheet is reminded once, from that many days before its period's last day until its due date. Once the due date has passed it is reminded once more as overdue. Only timesheets never submitted count — one sent back for a correction already told its owner so. The job looks back only a week past a due date (an operational constant, not policy), so the first run after an outage, or after this feature is switched on, does not remind everyone of every timesheet they ever left blank.

## The year-end summary goes out even when the rollover fails

The rollover job notifies every administrator what it forfeited and carried, keyed by the new year so a re-run does not repeat it. It is sent before the job fails for any employees it could not process, and says so: a failure is exactly when an administrator needs to look.

## Reports read the same sources as the screens they summarize

Balances as of a date are `SUM(minutes)` up to that date over everyone employed on it, leavers included for dates they were employed. A future date shows what is recorded, not the projection — a report of what the ledger says, not of what the engine expects. Leave taken is read from approved request days, the same source as the history page, so a day given back in a later year is not counted twice; leave recorded only as an adjustment does not appear. Forfeitures are every `FORFEIT` entry, labelled rollover or expiry from the key the job wrote. Every report's CSV comes from the same function as its page through one export route, with hours as numbers (a negative string would be caught by the formula guard) and the exact minutes alongside.

## Ledger entries record the run that wrote them

Decided by the owner on 2026-10-07, built in Phase 9. `LedgerEntry.jobRunId` is a nullable foreign key to `JobRun`, set by every job that writes the ledger (accrual, rollover, expiry) and null for anything a person did. `runJob` passes each job its run's id. It arrived before real data because it cannot be backfilled: nothing on an old row says which run wrote it. Phase 10's "reverse a job run" is then one query. The foreign key is `Restrict`, so a run with ledger rows cannot be deleted out from under them.

## An opening balance is this year's grants plus one adjustment

Posting each imported balance as a single `ADJUSTMENT` would double-grant. The next accrual run finds no `LUMP_GRANT` for the year and writes the whole allotment on top, and a per-pay-period policy's cumulative target catches the year up the same way. So `planOpeningBalance` (`lib/accrual/opening.ts`, pure) writes the grants the engine says were due by the cutover date, exactly as the jobs would (same kind, same key), and then one `ADJUSTMENT` for the difference. That adjustment absorbs everything the old system knew and this one doesn't, and it is always written, even at zero. Its key, `OPENING`, makes the unique index refuse a second import of the same balance; it is the one `ADJUSTMENT` with a key. A side effect: in the cutover year, leave taken before the cutover appears only inside that adjustment, not as `USAGE`, so the "leave taken" report starts at the cutover.

## The import is a script, and its dry run is a rolled-back transaction

The real staff list is loaded once, by whoever runs the deployment, from files they hold. A script (`scripts/import.ts`) keeps personal data out of the app's upload paths and out of GitHub. It runs the whole import in one transaction. Without `--commit`, it throws at the end to roll back, so the dry run is the real run, checked by every constraint and trigger, rather than a second implementation of the checks that could disagree with the first. Any error rolls back everything. Audit rows have a null actor and name the files.

## The production seed is configuration only, and needs the real anchor

`npm run db:seed` refuses production unless `SEED_CONFIGURATION_ONLY=true`. That mode loads the organization's configuration file (`SEED_CONFIG`, see `docs/CONFIGURATION.md`) with no sample staff. It also requires `SEED_PAY_ANCHOR_DATE`, because every pay period derives from the anchor, and a placeholder that slipped into production could not be corrected once timesheets existed.

## Missed runs are detected by absence, polled from outside

A failing job turns its workflow red. A job that silently stops (the workflow disabled, the secret rotated on one side only) produces nothing at all, and that is the failure most likely to go unnoticed for a year. `lib/jobs/health.ts` compares each job's last success with its cadence, generously: 3 hours for hourly, 30 for daily, 8 days for weekly, because GitHub's cron runs late and an alert that cries wolf gets muted. `/api/health/jobs` answers 503 when anything is overdue, and an Application Insights availability test polls it every 15 minutes. That check lives outside GitHub, so it still fires when GitHub is the thing that stopped. Liveness (`/api/health`, database reachable) is separate, because App Service restarts instances that fail their health check and a stopped cron is not the instance's fault.

## The database has a public endpoint behind a firewall

Postgres Flexible Server can live inside a virtual network with a private endpoint, or have a public endpoint with firewall rules. For ~100 staff the private network costs more (VNet integration for the app, private DNS) and makes the deploy's migrations impossible from GitHub-hosted runners. The public endpoint requires TLS and admits only the app's outbound addresses. The deploy workflow adds a rule for its own runner, migrates, and removes the rule in an `always()` step. Revisit if the church's policy requires private networking: the Bicep change is contained, but migrations would then need a self-hosted runner or to run at app startup.

## Migrations run from the deploy, before the code

The deploy workflow runs `prisma migrate deploy` from the runner and then deploys the new code. For a minute the previous release runs against the new schema, so every migration must be safe for the release before it: add a column nullable or with a default, backfill, and drop only in a later release. Running migrations at app startup instead would mean shipping the Prisma CLI inside the standalone bundle, and having every instance race to migrate on a scale-out.

## Secrets live in Key Vault, and the template writes only the one it composes

App Service settings reference Key Vault (`@Microsoft.KeyVault(...)`), read with the app's own system-assigned identity. The Bicep template writes only `DATABASE-URL`, which it builds from the password it was given and the server it created. `AUTH-SECRET`, `JOBS-SECRET`, `VAPID-PRIVATE-KEY` and the sign-in and mail secrets are set once by hand. Bicep cannot generate a stable random value: `newGuid()` produces a new one on every deployment, which would sign everyone out (`AUTH_SECRET`) and unsubscribe every browser (the VAPID key) on each redeploy.

## GitHub deploys with a federated identity, scoped to one environment

The deploy identity is a user-assigned managed identity whose only federated credential is `repo:<owner>/<repo>:environment:production`. No secret is stored in GitHub, and only jobs in that environment, which can require a reviewer, can use it. Its roles are scoped to the web app (Website Contributor), the Key Vault (to read `DATABASE-URL` for migrations) and the Postgres server (to open and close its own firewall rule).

## The build is Next's standalone output

`output: 'standalone'` traces the server's actual imports into `.next/standalone`, about 70 MB with the Prisma client, so App Service runs `node server.js` with no `npm install` on the server and no build there either. The workflow copies in `public/` and `.next/static`, which standalone leaves out. Tests and `npm run dev` are unaffected.

## Administrators override through the same services, never around them

Entering leave for someone, amending a request, cancelling approved overtime and filling in a timesheet each go through the function the employee's own action uses, with the administrator as actor and a reason. They get the same increments (rule 6), the same holiday and double-booking checks and the same locking. The exceptions are explicit flags, recorded in the audit row: "record as approved" skips the chain, and "allow overdraw" skips the balance check, but only alongside it. None is open on an administrator's own records; their own leave goes through their own chain like anyone's.

## A request can never be booked into a closed benefit year

Submitting, recording or amending leave refuses any day before the current benefit year. That year's rollover has already run on its closing balance, and usage dated into it would leave the carry and the forfeit wrong with nothing to correct them. This applies to employees too, who could previously backdate without limit. A closed year is corrected with a ledger adjustment, dated today.

## Amending approved leave gives the old days back and takes the new ones

The ledger is append-only (rule 2), so an amendment writes a `USAGE_REVERSAL` for each old day and `USAGE` for each new one, all under the same request. The history reads "taken, given back, taken again", and the request keeps its identity and approvals. The new days are judged as if the old ones were already returned. Leave on a timesheet that is submitted or approved cannot be amended until that timesheet is unlocked, because the timesheet copied the leave when it was submitted.

## Cancelling approved overtime takes the comp back with an adjustment

`COMP_EARNED` must be non-negative (a CHECK), so the reversal is an `ADJUSTMENT` against each comp entry the log wrote, on that entry's date, with the reason as its note and the log as its source. It may take the balance negative if the comp has been spent; that is the true position. Comp banked in a year that has since closed went through that year's rollover, so cancelling that log is refused and the correction is a judgement for a manual adjustment.

## An organization's configuration is a file the seed reads

The church's settings, departments, pay calendar, holidays, leave types, policies, rollover rules and carryover window moved out of `prisma/seed.ts` into a configuration file of its own, kept private, validated by `prisma/config/organization.ts`. Without `SEED_CONFIG` the seed loads `prisma/config/example.json`, a fictional organization, and development, CI and every test suite run against that — so the public copy is tested exactly as it will ship. Production names the file explicitly: `SEED_CONFIGURATION_ONLY=true` refuses to run without `SEED_CONFIG`, so the example cannot land in a real database by accident. The example starts with no sending address, as a new organization should; only the sample-data seed fills in `time@example.test`, so development still exercises mail. The example's policy figures are generic ones, not the church's. The sample administrator is `admin@example.test` (Morgan Ellis); the e2e specs read it, and the sending address, from `tests/e2e/people.ts`.

## Self-hosting is Docker Compose, with the jobs as a container

Azure stays the worked example for a managed deployment, but an organization without a subscription needs one command. `docker-compose.yml` runs PostgreSQL, a one-shot `migrate`, the standalone server, and a `jobs` container running `docker/scheduler.mjs` — the timetable of `.github/workflows/jobs.yml`, posting to the same routes with `JOBS_SECRET`. A container rather than host cron keeps the install to `docker compose up`, and the jobs' idempotence means a scheduler that fires twice, or a missed day rerun from Admin → Jobs, is harmless. The runtime image holds only the standalone output; migrations, `npm run setup` and the import run from a `tools` image with the full source. CI builds the stack and runs setup against it, so the path is tested even though it isn't the original deployment.

## A real installation starts with `npm run setup`, not the seed

The seed exists to make sample data. `npm run setup` writes the same configuration through `prisma/config/apply.ts` and creates one administrator instead, refuses a database that already has employees, and requires a real pay anchor. It takes `--mail-from` because an installation whose only sign-in method is emailed links would otherwise lock its first administrator out.

## The public repository is an export, not this repository's history

The original organization's files — its configuration file, Azure parameters and private docs — stay in its private repository, whose deploy identity is federated to it by name. The public repository is produced by an export script from `HEAD` as one fresh commit — the history contains the organization's name and addresses — and refuses to export if an identifier survives in a shared file.
