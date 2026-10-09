# Data model

Sketch, not literal Prisma. Every table gets `id` (cuid), `createdAt`, `updatedAt` unless noted.

## Core invariants

**1. Durations are integer minutes.** Every duration field is `Int`, named `*Minutes`, and holds minutes. No `Decimal`, no `Float`, no field named `hours`. Hours and half-days are a display concern, produced by `formatDuration()` at the render edge.

**2. `LedgerEntry` is append-only.** A balance is always `SUM(minutes)` over entries for an employee + leave type up to a date. No `balance` column exists anywhere. Mistakes are fixed by posting a reversing entry.

```
balance(employee, type, asOf) = SUM(minutes) WHERE employeeId = ? AND leaveTypeId = ? AND effectiveDate <= asOf
```

Because minutes are integers, a balance is exact — it never drifts, and two balances are safe to compare with `=`.

## Org & calendar

**OrgSettings** (single row)

| Field | Notes |
|---|---|
| `name`, `timezone` | |
| `benefitYearStartMonth`, `benefitYearStartDay` | |
| `minimumRequestIncrementMinutes` | Default **240** (half a day). Leave requests and comp-time spending must be a multiple. |
| `allowSubIncrementWhenBalanceIsLower` | Default `true`. See "Minimum increment" below. |
| `timesheetIncrementMinutes` | Default **15**. Hourly worked time, separate from the leave increment. |
| `displayUnit` | `HOURS \| DAYS`. How durations render. Does not affect storage. |
| `compTimeMultiplierBps` | Stored as basis points (`10000` = 1.0×) so it stays integer math. Read at final approval of an overtime log; the log records the rate it was banked at. |
| `overtimeWeeklyThresholdMinutes` | Default **2400** (40h) |
| `timesheetDueDaysAfterPeriodEnd` | Default **3**. A timesheet is due by the end of this many days after its period's last day, in the org's timezone. Lateness is shown, never enforced, and is judged by the first submission (the earliest approval step). |
| `workweekStartDay` | ISO weekday the FLSA workweek starts on, default **7** (Sunday). Overtime on timesheets is counted per workweek, which need not line up with the pay period. |
| `compLeaveTypeId` | The leave type approved overtime is banked into. Null switches overtime logging off. Must be an active `EXEMPT_ONLY` type — checked when saved and again at approval. |
| `compExpiresAfterDays` | Int, nullable, at least 1. Banked comp expires this many days after the day worked, and `expire-lots` forfeits the rest. Null: no expiry of its own; the type's rollover rule and windows still apply. |
| `workWeekDays` | ISO weekdays, default `[1,2,3,4,5]`. Only the request form's defaults read it — a range spanning a weekend starts with the weekend set to no leave. Any day may still be requested. |
| `mailFromAddress` | Nullable. The address email is sent from. Null sends no email at all, and emailed sign-in links are not offered. How mail leaves stays in the environment. |
| `notificationTypesEnabled` | `NotificationType[]`, default all five. A type not listed is never created. |
| `approvalReminderAfterDays`, `approvalReminderIntervalHours` | Defaults **7**, **24**. Reminders start once something has waited this long, at this interval. |
| `approvalEscalateAfterDays`, `approvalEscalateIntervalHours` | Defaults **3**, **4**. After a further this-many days, reminders come at this interval. CHECK: intervals positive. |
| `timesheetReminderDaysBeforePeriodEnd` | Default **2**. An open timesheet is reminded from this many days before its period ends. |
| `approverDigestHour` | Default **7**, 0–23 in the org's timezone. When approvers who chose a digest are sent it. |

**PaySchedule** — `name`, `type` (WEEKLY | BIWEEKLY | SEMI_MONTHLY | MONTHLY), `anchorDate`, `payDateOffsetDays`, `isDefault`.

**PayPeriod** — `payScheduleId`, `startDate`, `endDate`, `payDate`, `isLocked`. Unique on `(payScheduleId, startDate)`.

**Holiday** — `date`, `name`, `minutes`. Excluded from leave-day counting.

## People

**Employee** — `email` (unique), `firstName`, `lastName`, `accessRoleId` (nullable; what they may do beyond their own records — none is an ordinary employee), `role` (superseded by `accessRoleId` and no longer read; kept for the release before, dropped later), `employmentType` (HOURLY | SALARIED_EXEMPT), `hireDate`, `terminationDate` (nullable), `departmentId`, `payScheduleId`, `standardMinutesPerDay` (Int, default **480**), `isActive`, `needsReview` (set on anyone created from the directory, or whose directory account was disabled; saving the record clears it), `approvalDigest` (approval email as one daily digest instead of one each), `employeeTypeId` (nullable; the employee type they were created from, kept as a label).

**AccessRole** — `name` (unique), `description`, `permissions` (`Permission[]`), `allPermissions` (true only for the built-in Administrator, which cannot be edited or deleted). What each permission means is in `lib/permissions.ts` and `docs/SPEC.md`. Deleting a role somebody holds is refused (`Restrict`).

> `standardMinutesPerDay` is what makes "half a day" meaningful per person. A 480-minute employee at a 240-minute increment requests in half-days; a part-timer on 240 requests in whole days.

> `employmentType = SALARIED_EXEMPT` gates comp-time accrual. Check it in the service layer *and* as a DB constraint on `COMP_EARNED` entries.

**Identity** — `employeeId`, `provider` (MICROSOFT | GOOGLE), `subject` (Entra object id or Google `sub`), `tenant`, `email`, `directoryAccountEnabled`, `directoryManagerSubject` (the account's manager at the last sync; a change is what flags an approval chain for review), `lastUsedAt`. Unique on `(provider, subject)`. A Microsoft or Google account bound to an employee, matched by `subject` after the first sign-in so a changed address does not lock anyone out. Replaced `Employee.entraOid`.

**DirectoryConnection** — `provider` (unique), `tenantId`, `domains` (non-empty), `autoProvision`, `chainsFromManager` (start an empty approval chain with the directory manager, and flag a manager change), `connectedById`, `lastSyncAt`, `lastSyncDetail`. The organization's own Microsoft tenant or Google Workspace, registered by an administrator. Only accounts from it, with addresses in its domains, are linked by email or imported.

**SignInLinkRequest** — `email`, `ipAddress`, `employeeId`, `tokenHash` (unique), `expiresAt`, `usedAt`. Every request for an emailed sign-in link; the rate limits count them. Only a request for an employee who may sign in has a token, and only its SHA-256 is stored.

See `docs/AUTH-PLAN.md` for how these fit together.

**Department** — `name`, `defaultApprovalChain` (relation).

**ApprovalChainStep** — `employeeId`, `step` (int, 1-based), `approverId`. Unique on `(employeeId, step)`.

## Leave configuration

**LeaveType** — `code` (PTO | SICK | COMP | custom), `name`, `isPaid`, `requiresApproval`, `allowsNegativeBalance`, `countsTowardRollover`, `accruableBy` (ALL | HOURLY_ONLY | EXEMPT_ONLY), `colorHex`, `isActive`.

**LeavePolicy** — `leaveTypeId`, `name`, `method` (ANNUAL_LUMP | PER_PAY_PERIOD), `annualMinutes` (Int), `maxBalanceMinutes` (Int, nullable), `waitingPeriodDays` (Int, default 0), `firstYearGrant` (PRORATE | FULL_AFTER_WAITING | NONE), `isActive`.

> `firstYearGrant` encodes what a new hire gets. `FULL_AFTER_WAITING` with `waitingPeriodDays = 120` is our rule: the complete annual allotment, not a prorated slice, once the waiting period ends. `PRORATE` gives a share based on the remainder of the year. See "Lump grant date" below.

**EmployeeLeavePolicy** — `employeeId`, `leavePolicyId`, `annualMinutesOverride` (nullable), `effectiveFrom`, `effectiveTo` (nullable). Unique on `(employeeId, leavePolicyId, effectiveFrom)`. At most one active policy per leave type per date — enforced in the service layer.

**EmployeeType** — `name` (unique), `employmentType` (HOURLY | SALARIED_EXEMPT), `isActive`, `sortOrder`. A starting profile for new employees — Pastor, Director, Associate, or whatever the organization calls its staff; the names are an administrator's.

**EmployeeTypePolicy** — `employeeTypeId` (cascade), `leaveTypeId`, `leavePolicyId` (restrict). Unique on `(employeeTypeId, leaveTypeId)`: at most one default policy per leave type, and a leave type with no row gets none. That the policy belongs to `leaveTypeId`, and that the type's employment type may hold it, are checked in the service layer.

> A type is a **pre-fill template**, not a live link. Creating an employee from one writes ordinary `EmployeeLeavePolicy` rows (from the hire date, open-ended, no override) and sets `Employee.employeeTypeId`; nothing reads the type again. Editing the type, or changing an employee's type label, changes no one's assignments — so a type never has to be reconciled against the people made from it.

**RolloverRule** — org-wide, one per leave type (`leaveTypeId` unique).

| Field | Notes |
|---|---|
| `capBasis` | `NONE \| UNLIMITED \| FIXED_MINUTES \| EMPLOYEE_DAYS` |
| `capValue` | Int. Minutes when `FIXED_MINUTES`; a day count when `EMPLOYEE_DAYS`; ignored otherwise. |
| `carriedExpiresAfterDays` | Int, nullable. Carried time expires this many days into the new year. |

`EMPLOYEE_DAYS` multiplies `capValue` by that employee's `standardMinutesPerDay`, so "5 days" means 2400 minutes for full-time staff and 1200 for someone on a 4-hour day. Expressing the cap in days is what keeps it fair across schedules — a fixed minute cap would quietly favor part-timers.

**CarryoverWindow** — zero or more per leave type. An exception that lets time earned in a defined window survive a rollover it would otherwise fail, for a limited period.

| Field | Notes |
|---|---|
| `leaveTypeId`, `name` | |
| `earnedFromMonth`, `earnedFromDay` | Start of the earning window (inclusive) |
| `earnedToMonth`, `earnedToDay` | End of the earning window (inclusive) |
| `usableUntilMonth`, `usableUntilDay` | Expiry date in the new year |
| `usableUntilYearOffset` | Int, default 1 (the following year) |
| `capBasis`, `capValue` | Nullable. Uncapped when null. |
| `isActive` | |

Our comp-time rule is one row: earned Dec 1–Dec 31, usable until Feb 28 of the following year, uncapped. Nothing about December or February appears in code.

**A configured day at or past the shortest that month can ever be means the end of the month.** So "31" in a 30-day month is the 30th, and February 28 is *the end of February* — it resolves to the 29th in a leap year. That last case is the one that matters: the policy was written in a common year, and reading it literally would expire everyone's carried comp a day early every fourth year. A day below that threshold is taken literally: the 15th is the 15th.

`usableUntil` is offset from the calendar year the earning window *ends* in, not from the benefit year's label, so a non-calendar benefit year still points at the right February.

## The ledger

**LedgerEntry** — append-only.

| Field | Notes |
|---|---|
| `employeeId`, `leaveTypeId` | |
| `effectiveDate` | `DATE`. Drives balance-as-of queries. |
| `minutes` | `Int`, **signed**. Grants positive; usage and forfeits negative. |
| `kind` | `LUMP_GRANT \| PERIOD_ACCRUAL \| ROLLOVER_IN \| FORFEIT \| USAGE \| USAGE_REVERSAL \| COMP_EARNED \| ADJUSTMENT` |
| `expiresOn` | `DATE`, nullable. Set on grants that expire — carried comp, time-limited awards. Null means it never expires. |
| `periodKey` | Idempotency key, e.g. `2026-PP07`, `2026-ROLLOVER`. Null for manual entries, except the import's opening balance, keyed `OPENING` so it can be imported only once. |
| `sourceType`, `sourceId` | Polymorphic link to what the entry is for: a LeaveRequest, OvertimeLog, or the LeavePolicy a job granted under. |
| `jobRunId` | The `JobRun` that wrote the entry; null for anything a person did. Every job sets it, so one run's work can be found, and in Phase 10 reversed, with one query. Added before production data because it cannot be backfilled. |
| `note` | Required for `ADJUSTMENT`. |
| `createdById` | Nullable for system-generated entries. |

**Unique index:** `(employeeId, leaveTypeId, kind, periodKey)` where `periodKey IS NOT NULL`. This is what makes re-running a job safe.

**Index:** `(employeeId, leaveTypeId, effectiveDate)` for balance queries.

**BalanceSnapshot** (optimization, add only if balance queries get slow) — `employeeId`, `leaveTypeId`, `asOfDate`, `minutes`. Derived cache, rebuildable from the ledger at any time.

## Requests

**LeaveRequest** — `employeeId`, `leaveTypeId`, `status` (DRAFT | PENDING | APPROVED | DENIED | CANCELLED), `totalMinutes`, `note`, `submittedAt`, `resolvedAt`.

**LeaveRequestDay** — `leaveRequestId`, `date`, `minutes`. Unique on `(leaveRequestId, date)`. Each row's `minutes` is validated against the minimum increment.

**ApprovalStep** — `step`, `approverId`, `status` (PENDING | APPROVED | DENIED | SKIPPED), `decidedById`, `decidedAt`, `comment`, and exactly one of `leaveRequestId` / `overtimeLogId` / `timesheetId` (timesheets join in Phase 7). Snapshots the chain at submission, so later chain edits don't rewrite history.

- `approverId` is **null for the empty-chain step**: any administrator may act on it, except the requester.
- `decidedById` is who actually decided, which differs from `approverId` when an administrator overrides.
- A requester who appears in their own chain gets a `SKIPPED` step with a comment, rather than being left out, so the history shows why nobody acted on it. A chain with nobody left to act on it routes to administrators.
- Steps after a denial, or left when a request is cancelled, close as `SKIPPED` — they are never notified.
- Database guarantees: a decided step has a `decidedAt`; a pending one has neither `decidedAt` nor `decidedById`; and a trigger refuses any `APPROVED` or `DENIED` step whose decider is the requester.

**What touches the ledger.** Nothing until the last step approves. Then one `USAGE` entry per day, dated on that day, with `sourceType = 'LeaveRequest'` and a null `periodKey` — the request row's lock is what stops a double write. Cancelling approved leave writes one `USAGE_REVERSAL` per day and leaves the `USAGE` rows in place. A reversal is dated on its own day, except a day in an already-closed benefit year, which is given back on the current year's first day (see DECISIONS.md).

**OvertimeLog** — `employeeId`, `date`, `minutes`, `note` (required), `status` (PENDING | APPROVED | DENIED | CANCELLED), `multiplierBps` and `earnedMinutes` (set on approval, null otherwise — a CHECK holds them to the status), `submittedAt`, `resolvedAt`. Validated against `timesheetIncrementMinutes`, not the leave increment — overtime is time actually worked. The date is no later than today and no earlier than the start of the previous benefit year; one pending or approved log per employee per day.

> Rule 4 is enforced on the row: a trigger refuses an `OvertimeLog` for anyone but a `SALARIED_EXEMPT` employee, on insert and again on the update to `APPROVED`, so someone who became hourly while a log was pending cannot have it approved by any route. The ledger's `COMP_EARNED` trigger stands behind it.

**What an approved log writes.** One `COMP_EARNED` entry against the comp type, at `minutes × compTimeMultiplierBps / 10000` rounded to the nearest minute (a half rounds up), dated on the day worked, with `sourceType = 'OvertimeLog'` and `periodKey = 'OT-<logId>'`. When the day worked is in a benefit year that has since closed, the entry is instead dated on the current year's first day and holds only what that year's rollover would have carried — computed by running the rollover with and without the overtime — with the expiry the carry would have had. See DECISIONS.md.

## Timesheets

**Timesheet** — `employeeId`, `payPeriodId`, `status` (OPEN | SUBMITTED | APPROVED | REJECTED), `submittedAt`, `resolvedAt`. Unique on `(employeeId, payPeriodId)`, which is what makes the daily `create-timesheets` job safe to re-run. There is no `isLocked`: a timesheet is locked exactly when it is `APPROVED`, and a second column could only disagree with the first. OPEN and REJECTED are editable; SUBMITTED and APPROVED are not, and a trigger refuses any change to their entries. It is the third subject of an `ApprovalStep` (`timesheetId`); a resubmission numbers its steps after the previous round's.

**TimeEntry** — `timesheetId`, `date`, `minutes` (positive), `category` (REGULAR | HOLIDAY | LEAVE), `note`, `leaveRequestId` and `leaveTypeId` (set on LEAVE rows and only there). REGULAR is time worked, entered by the employee and validated against `timesheetIncrementMinutes`; one per day. HOLIDAY and LEAVE are frozen from the holiday calendar and approved requests when the timesheet is submitted — while it is open they are read live and not stored.

There is no OVERTIME category. Overtime is computed from the REGULAR rows of each workweek — the part of each day beyond `overtimeWeeklyThresholdMinutes`, counting from the week's first day, including days on the previous period's timesheet — so the regular/overtime split can never disagree with the hours. Leave and holidays do not count toward it. See `lib/timesheets/overtime.ts` and docs/DECISIONS.md.

## Notifications

**Notification** — `recipientId`, `type` (APPROVAL_WAITING | REQUEST_DECIDED | TIMESHEET_DUE | TIMESHEET_OVERDUE | ROLLOVER_SUMMARY), `key`, `title`, `body`, `url`, `readAt`, `pushStatus` and `emailStatus` (PENDING | SENDING | SENT | FAILED | DIGEST, or null when not owed on that channel), `attempts`, `lastError`. Unique on `(recipientId, key)`, which is what makes the hourly sweep safe to re-run: a reminder's key names its step and slot (`reminder:<step>:<approver>:daily-2`), a timesheet reminder its timesheet. Written in the transaction of the change it announces; the row is the in-app list, and push and email are delivered from it.

**NotificationPreference** — `employeeId`, `type`, `push`, `email`. Primary key `(employeeId, type)`. No row means both on.

**PushSubscription** — `employeeId`, `endpoint` (unique), `p256dh`, `auth`, `userAgent`, `lastSuccessAt`. One per browser; deleted when the push service says it has gone.

**NotificationDigest** — `employeeId`, `date` (DATE, org timezone), `itemCount`. Unique on `(employeeId, date)`: claimed before the digest email is sent, released if sending fails.

## Audit

**AuditLog** — `actorId` (nullable for system), `action`, `entityType`, `entityId`, `before` (Json), `after` (Json), `reason`, `createdAt`. Never updated or deleted.

**JobRun** — `jobName`, `periodKey`, `startedAt`, `finishedAt`, `status`, `entriesCreated`, `detail` (Json, what a successful run did), `error` (set only on a failure). Keeping the two apart means a run log never shows a successful summary in the column someone is scanning for failures. Its latest success per job is also what missed-run detection reads (`lib/jobs/health.ts`).

## Minimum increment

`minimumRequestIncrementMinutes` (default 240) constrains **what an employee may request or spend**, not what the system may accrue. Accrual is exact to the minute; a per-pay-period policy will routinely grant amounts like 277 minutes, which is correct and must not be rounded.

Validation applies to each `LeaveRequestDay.minutes`:

```
minutes > 0 AND minutes % org.minimumRequestIncrementMinutes == 0
```

**The stranded-balance exception.** At a 240-minute increment, an employee holding 180 minutes could never spend it — the balance is stranded forever and inflates the org's liability. When `allowSubIncrementWhenBalanceIsLower` is `true` (the default), a single-day request is also valid if its minutes equal the employee's entire remaining balance for that type **and that balance is below one increment**. Both conditions matter: without the second, any balance could be requested in full as a non-multiple entry, waiving the increment rule. That's the only way to produce a non-multiple usage entry.

Timesheets use `timesheetIncrementMinutes` (default 15) instead. Hours actually worked aren't a half-day concept, and forcing worked time into 4-hour blocks would make payroll wrong.

## Per-pay-period accrual with remainders

`annualMinutes / periodsPerYear` rarely divides evenly: 7200 minutes over 26 periods is 276.92. Granting a rounded 277 each period overshoots the annual allotment by 2 minutes; truncating to 276 undershoots by 24.

Compute each grant from the cumulative target instead:

```
targetToDate = round(annualMinutes * periodsElapsedThisYear / periodsPerYear)
grant        = targetToDate - (minutes already PERIOD_ACCRUAL'd this benefit year)
```

Grants alternate between 277 and 276 as needed, the running total is never off by more than a minute, and the year-end total is exactly `annualMinutes`. The formula also self-corrects after a skipped or backfilled period, so a late job run catches up on its own rather than permanently losing a grant.

**`periodsElapsedThisYear` counts the periods the employee is *eligible* for**, starting at the same `max(benefitYearStart, hireDate + waitingPeriodDays)` the lump grant uses. Counting from the year start instead would hand a new hire whose waiting period ends in period 10 ten twenty-sixths of the allotment in a single grant.

The divisor follows from that:

- An employee eligible from day one is divided by the **nominal** `periodsPerYear` for the schedule — 26 for biweekly, whatever the calendar holds. A biweekly year occasionally contains 27 periods, and paying 27/26 of the allotment that year is deliberate.
- A deferred employee is divided by the **periods they are actually eligible for**, so `FULL_AFTER_WAITING` means the whole allotment spread across the rest of the year and still sums to exactly `annualMinutes`. `PRORATE` and `NONE` size the entitlement first and then spread it the same way.

`maxBalanceMinutes` caps each grant rather than cancelling it: a balance 60 minutes below the ceiling still accrues those 60. Accrual stops at the ceiling and resumes when the balance drops, and because the target is cumulative the paused periods are then caught up — bounded by the headroom that opened, so a pause can never become a windfall.

## Lump grant date

One `LUMP_GRANT` per employee, leave type, and benefit year — `periodKey = <year>-LUMP`. The date is:

```
grantDate = max(benefitYearStart, hireDate + policy.waitingPeriodDays)
if grantDate > benefitYearEnd  → no grant for this year
if employee.terminationDate exists and < grantDate → no grant
```

One formula covers every case. An existing employee gets their allotment on January 1, because the waiting period is long past. Someone hired March 1 gets theirs on June 29. Someone hired November 1 has a waiting period ending the following March, so they get nothing for the hire year and a full allotment dated March 1 of the next year rather than January 1 — which is the correct reading of "120 days after your start date."

The amount depends on `firstYearGrant`, and only in the benefit year containing the grant date when that date was pushed by a waiting period:

- `FULL_AFTER_WAITING` → the entire `annualMinutes`
- `PRORATE` → `round(annualMinutes × remainingDaysInYear ÷ daysInYear)`
- `NONE` → nothing until the next benefit year starts

## Lots and expiry

A **lot** is a single grant entry that can be consumed. Expiry needs to know how much of a *particular* grant is left, which a running balance can't answer.

`lotBalances(employeeId, leaveTypeId, asOf)` is a pure function that replays the ledger: it walks positive entries as lots and applies negative entries (usage, forfeits) against them in **consumption order**, returning each lot's unconsumed remainder.

**Consumption order: soonest `expiresOn` first (nulls last), then oldest `effectiveDate` first.** Spending the time that is about to disappear before the time that never will means employees lose the least. The alternative — strict FIFO — would burn permanent PTO while a December comp lot quietly expired.

Within a single day the replay applies **forfeits first, then grants, then everything else**. Both halves matter and the rollover is where they collide: it writes a `FORFEIT` of the closing balance and a `ROLLOVER_IN` of the carried amount *on the same date*. A forfeit can only ever remove time that was already there, so if the carried lot were created first the forfeit would consume it — it is the soonest-expiring thing in the account — and leave the old balance sitting there with no expiry. Carried December comp would then never run out. Grants come before ordinary consumption so that leave taken on the day it was granted draws on that grant rather than overdrawing the account.

This function is only needed by the expiry and rollover jobs. Ordinary balance reads stay a plain `SUM(minutes)`, so the common path keeps its simplicity.

The `expire-lots` job runs daily: for every lot where `expiresOn < today` with a remainder above zero, post a `FORFEIT` for that remainder, dated `expiresOn + 1 day`, with `periodKey = <lotEntryId>-EXPIRY`.

## Benefit-year rollover

At the benefit year boundary, per employee and leave type:

1. `B` = closing balance on the last day of the old year. If `B <= 0`, write nothing and stop.
2. `baseCarry` = the `RolloverRule` cap applied to `B`.
3. `windowCarry` = the unconsumed remainder of every lot whose `effectiveDate` falls inside an active `CarryoverWindow`, each capped by its own cap if set.
4. `carry = min(B, baseCarry + windowCarry)`.
5. **`FORFEIT` of `−B`**, dated day 1 of the new year. This zeroes the type.
6. One **`ROLLOVER_IN`** per carry source, dated day 1, positive: the base carry with `expiresOn` from `carriedExpiresAfterDays`, and one per matched window with `expiresOn` set to that window's resolved date.
7. `LUMP_GRANT` for `ANNUAL_LUMP` policies, per the grant date above.

> **Zero out, then re-grant.** Because a balance is a cumulative `SUM` over all time, it carries forward on its own — so rollover works by *removing* what isn't kept, not by moving money. Writing a `ROLLOVER_IN` without first forfeiting the full closing balance would double the employee's time. Step 5 before step 6, always.

Steps 5 and 6 share `periodKey = <year>-ROLLOVER` and must be written in one transaction.

> **One key per carry source.** The unique index is on
> `(employeeId, leaveTypeId, kind, periodKey)`, so two `ROLLOVER_IN` rows under
> one key would collide and the second carry would be silently dropped. The
> base carry keeps `<year>-ROLLOVER`, pairing it with its forfeit; each window
> carry is written as `<year>-ROLLOVER-<windowId>`. Idempotency is unchanged
> and the window's own key survives an admin renaming the window.

> **The base carry takes priority over a window carry.** When the two overlap,
> `carry = min(B, baseCarry + windowCarry)` has to trim something, and it trims
> the window share. Base carry is usually permanent while window carry expires,
> so keeping the base means the employee loses the least — the same principle
> as the consumption order.

## Job schedule

| Job | Cadence | Writes |
|---|---|---|
| `accrue-pay-period` | Daily; acts on periods ending today, and on lump grants that have come due | `PERIOD_ACCRUAL`, `LUMP_GRANT` |
| `benefit-year-rollover` | Daily; acts on the benefit-year start date | `ROLLOVER_IN`, `FORFEIT`, `LUMP_GRANT`; the administrators' rollover summary |
| `expire-lots` | Daily | `FORFEIT` for lots past `expiresOn` |
| `generate-pay-periods` | Weekly; keeps 24 months ahead | `PayPeriod` |
| `send-notifications` | Hourly | `Notification` (approval reminders, timesheet due/overdue), `NotificationDigest`; then delivers pending push and email |
| `create-timesheets` | Daily | `Timesheet` |
| `sync-directory` | Daily | `Employee`, `Identity` |

The rollover job writes every lump grant for the new year, but it cannot know about someone hired in March, so the daily accrual picks those up on the day the waiting period ends. Both write the same `<year>-LUMP` key, so whichever runs first wins and the other is a no-op.

All are idempotent and safe to re-run for a past date. Each writes a `JobRun`. They are reachable two ways, both ending in the same wrapper and the same `JobRun` row: `POST /api/jobs/<name>` with the `JOBS_SECRET` shared secret (how the cron runs them), and a button on `/admin/jobs` authenticated as an administrator (how a missed day is recovered). Both accept `?date=YYYY-MM-DD` to act on a past date.

Scoping is by employment history, not by the `isActive` flag: `isActive` governs sign-in and has no history, so a job acting on a past date uses `terminationDate` instead. Otherwise a backfill would skip everyone who has left since.
