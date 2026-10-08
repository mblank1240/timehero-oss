# Spec

Written for the church TimeHero was first built for. Where it says "our" or
"the church", the figures are that organization's, kept as worked examples;
every one of them is a setting. The example configuration TimeHero ships with
(`docs/CONFIGURATION.md`) uses its own figures.

## Roles

| Role | Can |
|---|---|
| **Employee** | View own balances & history, request leave, log overtime (if exempt), submit timesheets (if hourly) |
| **Approver** | Everything above, plus act on requests routed to them. Not a separate role — any employee can appear in someone's approval chain. |
| **Finance** | Everything an employee can, plus read every timesheet and download the payroll exports. Changes nothing: no settings, no unlocks, no overrides. |
| **Admin** | All of the above org-wide: manage employees, policies, accruals, approval chains, pay schedules, rollover caps; post manual ledger adjustments; override, deny, skip or reroute any approval; enter leave for anyone (through their chain or recorded as approved), amend a pending or approved request, cancel approved overtime, fill in and submit anyone's timesheet — each with a reason, never on their own records |

Role lives on the Employee record. Entra group sync is a later option, not v1.

## Authentication

Microsoft Entra ID (M365) via Auth.js. First sign-in matches the Entra `oid`/UPN to an Employee row.
No matching active employee → access denied with a "contact your administrator" message. No self-registration.

## Leave types

Seeded: **PTO**, **Sick**, **Comp Time**. Admins can add more (Bereavement, Jury Duty) — types are rows, not enum values.

Per type, configurable: paid/unpaid, requires approval, may go negative, counts toward rollover, who may accrue it.

## Time units and increments

All time is **stored in minutes** as whole numbers. Hours and days exist only on screen.

Employees take time off in **increments**, set org-wide in settings as `minimumRequestIncrementMinutes`. Ours is **240 minutes (half a day)**, so with a standard 8-hour day a request is some number of half-days. An admin can change this to 480 (full days only), 60 (hourly), or anything else without a code change.

Three rules follow:

1. **Requests are validated against the increment.** Each day of a leave request must be a positive multiple of it. The form offers the valid choices rather than a free-text box, so a half-day picker is what an employee actually sees.
2. **Accrual ignores the increment.** A per-pay-period policy grants exact minutes — often an odd number like 277. Rounding accruals to the increment would quietly cost employees time every period.
3. **Timesheets use their own, smaller increment** (`timesheetIncrementMinutes`, default 15). Hours actually worked aren't a half-day concept, and rounding worked time to 4-hour blocks would make payroll wrong.

**Stranded balances.** At a 240-minute increment, someone holding 180 minutes could never spend it. With `allowSubIncrementWhenBalanceIsLower` on (the default), a single-day request is valid when it equals the employee's exact remaining balance **and that balance is below one increment**. This is the only path to a non-multiple usage entry.

Both conditions are required. Without the second, someone holding 7130 minutes could request all 7130 as a single entry and bypass the increment rule entirely. The narrower rule strands nothing: a 500-minute balance is simply spent as 480 and then 20.

## Accrual

Each employee is assigned a **LeavePolicy** per leave type. Two methods:

- **`ANNUAL_LUMP`** — the full annual allotment is granted as one entry dated the first day of the benefit year, alongside any rollover from the prior year.
- **`PER_PAY_PERIOD`** — the annual allotment spread across the year's periods, granted on each period's end date. Since it rarely divides evenly, each grant is computed from a cumulative target so the year-end total lands exactly on the allotment — see DATA-MODEL.md.

An assignment may override the policy's allotment (e.g. a 15-year staffer on the standard PTO policy at 200h instead of 120h).

The benefit year is org-wide: a configurable start month/day. Ours is the calendar year, but a fiscal year such as July 1 is a settings change.

### New hires

A policy's `firstYearGrant` setting decides what someone gets in their hire year: the full allotment once a waiting period ends, a prorated share, or nothing until the next year. **Our rule is the full allotment, 120 days after the start date** — `FULL_AFTER_WAITING` with `waitingPeriodDays = 120`.

A single formula covers everyone: the grant lands on `max(benefit year start, hireDate + waitingPeriodDays)`, once per benefit year. Existing staff are granted on January 1 because their waiting period is long past. A March 1 hire is granted on June 29. A November 1 hire's waiting period ends the following March, so they receive nothing in the hire year and a full allotment dated March 1 — not January 1 — which is what "120 days after your start date" actually means.

Changing 120 to any other number, or switching a policy to proration, is an admin settings edit with no code change.

## Rollover

Rollover caps are set **org-wide per leave type**, not per employee. Each type's cap is one of: none, unlimited, a fixed number of minutes, or **a number of the employee's own working days**.

Our configuration uses the day-based form: PTO carries **5 days**, which is 2400 minutes for full-time staff and 1200 for someone on a 4-hour day. Expressing the cap in days rather than fixed minutes is what keeps it fair across schedules.

At the benefit-year boundary, per employee and type:

1. Compute the closing balance `B` on the last day of the old year.
2. Determine what carries: the type's cap applied to `B`, plus anything rescued by a carryover window (below).
3. Write a `FORFEIT` of the **full** closing balance, dated day 1 of the new year.
4. Write a `ROLLOVER_IN` for the carried amount, same date, with an expiry date where one applies.
5. For `ANNUAL_LUMP` policies, the new year's grant.

Steps 3 and 4 look redundant but aren't: a balance is a cumulative sum over all time, so it carries forward by itself. Rollover zeroes the type and re-grants what's kept. Doing only step 4 would double everyone's balance. The pair also makes the ledger legible — "you had 200, 160 forfeited, 40 carried" — instead of a bare net adjustment.

### Carryover windows

A type can have exceptions: time earned during a defined window survives a rollover it would otherwise fail, usable for a limited period into the new year.

**Our comp-time rule is one such window** — comp doesn't roll over at all, except what's earned in December, which stays usable through February. That's configured as: earned Dec 1–Dec 31, usable until Feb 28 of the following year, uncapped. On March 1 anything left expires automatically.

The window's dates, the type it applies to, and any cap are all admin-editable rows. Nothing about December or February exists in code, so if the board later extends the grace period to March, or grants the same treatment to PTO, that's a settings change. Day-of-month values past the end of a month clamp, so February 29 resolves correctly in leap years.

### Expiring time

Any grant may carry an expiry date, and the system tracks how much of *that specific grant* is still unspent — a running balance alone can't tell you whether a December comp hour has already been used.

Time is spent **soonest-to-expire first**, so employees lose the least possible. Spending permanent PTO while a February-expiring comp balance quietly ran out would be the wrong behavior. A daily job forfeits whatever remains past its expiry date, and the employee sees it in their history as an explicit forfeiture rather than a balance that silently shrank.

Policies may also set `maxBalanceMinutes` — an any-time ceiling that halts further accrual while the balance sits at or above it. Skipped accruals are recorded as zero-hour entries with a reason, so an employee can see why they stopped accruing.

## Comp time

For **exempt (salaried) employees only** — see rule 4 in CLAUDE.md. Hourly staff are not offered overtime logging, and the server and database refuse it.

1. Employee logs overtime worked: date + time worked + note, in timesheet increments (15 min), not leave increments.
2. It runs through the same approval chain as a leave request.
3. On final approval, a `COMP_EARNED` entry is written against the Comp Time type at the org's configured multiplier (default 1.0), dated on the day worked. Which leave type receives it is an org setting; clearing it switches overtime logging off.
4. Spending comp time is an ordinary leave request against the Comp Time type, so it follows the 240-minute leave increment. Odd remainders banked at 15-minute granularity are spendable via the stranded-balance exception above.

An employee may withdraw a log while it is pending. Approved overtime is not cancelled in the app — the comp may already be spent — so taking it back is an administrator's ledger adjustment with a reason.

A log can be submitted for any day back to the start of the previous benefit year. One approved after the year it was worked in has closed banks only what that year's rollover would have kept: December overtime approved in January arrives with the December window's February expiry; November overtime approved in January banks nothing, exactly as if it had been approved on time and forfeited on 1 January. The log's page shows the approver what approval will bank before they decide.

Comp may optionally expire a set number of days after it was worked (`compExpiresAfterDays`, unset at the church); the daily expiry job forfeits what is left.

Comp time's rollover behavior is a `RolloverRule` plus any `CarryoverWindow` rows, exactly like every other leave type. Ours is a cap of **none** with a single window covering December — see Rollover above. Employees see the February expiry date on their dashboard while a carried comp balance exists, so "use it or lose it" is visible rather than a surprise.

## Approval chains

Each employee has an **ordered** chain of approvers (step 1, 2, 3…). Admins edit it per employee; a default chain can be set per department.

Flow: request submitted → step 1 notified → approves → step 2 notified → … → last step approves → request is `APPROVED` and `USAGE` entries are written, one per day.

- Any step denying ends the request as `DENIED`. Later steps are never notified.
- An employee may cancel while `PENDING`. Cancelling an already-approved future request writes `USAGE_REVERSAL` entries; the originals stay.
- Admins can approve any step, skip a step, or reroute — each action audit-logged with a required reason.
- An approver appearing in their own chain is skipped automatically.
- Empty chain → routes to all admins; any one of them can approve.

Balance is checked at submission and re-checked at final approval. Insufficient balance blocks submission unless the type allows negative balances.

## Employee views

- **Dashboard** — balance per leave type, hours pending approval, next accrual date and amount, upcoming approved time off, and a warning for any balance with an expiry date approaching.
- **Request time off** — date range, then per day a picker of valid increments (Half day / Full day at our settings, defaulting to a full day), type, note. The picker is generated from the org increment and the employee's `standardMinutesPerDay`, so it stays correct if either changes. Shows the projected balance on the requested dates, including scheduled future accruals.
- **History** — a GitHub-contribution-style calendar heatmap of days used, colored by leave type, one year per row, with a filterable table beneath.
- **My requests** — status of each, with the chain's current position visible.

## Timesheets (hourly employees)

- One timesheet per employee per pay period, auto-created when the period opens.
- Daily entries: time worked (15-minute increments) + optional note. Holiday and leave rows are filled in from the holiday calendar and approved requests, and read-only. Overtime is not entered: it is computed from each workweek.
- Submit → approval chain → approved → the period locks for that employee.
- Admins see a per-period grid of who has submitted, and can unlock a locked timesheet (audit-logged).
- Overtime flags above 2400 minutes/week (40h) of time worked; the threshold and the day the workweek starts are configurable. Leave and holidays do not count toward it.
- Due a configurable number of days after the period ends — at the church, periods run Sunday to the second Saturday and are due the following Tuesday. Late timesheets are accepted and marked late, judged by the first submission.
- Administrators and finance download a CSV per employee per pay period (a row per day, then totals), a summary CSV with a row per employee, or every employee's CSV at once as a .zip. The exact format finance needs is still to be confirmed.

## Pay schedules

Admin-configurable, biweekly by default:

- Type: `WEEKLY` | `BIWEEKLY` | `SEMI_MONTHLY` | `MONTHLY`
- Anchor date (first period start), period length, pay-date offset
- Multiple schedules may coexist; each employee is assigned one.

Periods are generated 24 months forward and stored as rows, so accrual and timesheets reference stable IDs. Changing a schedule regenerates only future unlocked periods.

## Notifications

Every organization gets push notifications (Web Push to each browser a person turns it on in, plus an in-app list). Email is added only when an administrator sets an address to send from — e.g. `time@example.org`, through Microsoft Graph or SMTP; with no address, no email is sent and emailed sign-in links are not offered. On iPhone and iPad, push works only once TimeHero is added to the home screen (iOS 16.4+), and the opt-in says so. Notifications:

- Approver: a leave request, overtime log or timesheet is waiting on you — on arrival, when an earlier step approves, or when it is rerouted to you
- Requester: approved / denied / sent back, with the approver's comment
- Employee: timesheet due (from a set number of days before the period closes — 2 at the church), timesheet overdue (once its due date has passed, if never submitted)
- Admin: year-end rollover summary

Each type can be switched off org-wide, which stops it entirely. For the rest, each person chooses push and email per type (both on by default). Approvers can opt into a daily digest at a set hour instead of per-request **email**; push and the list still arrive one at a time. Anything left waiting on an approver escalates — once on arrival, daily after a set number of days, more often after a further set number — with all four numbers as settings (the church: 7 days, daily, a further 3 days, every 4 hours). Each reminder is sent once, however often the hourly job runs.

## Reporting (admin)

Under `/reports`, for administrators and finance: balance report as of any date; leave taken by type and date range (approved request days, as a summary per employee and type or a row per day); timesheet export per pay period; forfeiture report (year-end rollover and expiry); full ledger for one employee with running balances. All exportable to CSV — hours to two decimals with the exact minutes alongside.

## Out of scope for v1

Payroll system integration (CSV export only), FMLA tracking, shift scheduling, native mobile apps (the web UI is responsive), multi-org tenancy.
