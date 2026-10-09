# Configuring an organization

Every policy TimeHero applies is data: the leave types, how much each policy
grants and when, what rolls over at the end of the benefit year, the pay
calendar and the holidays. None of it is in code (rule 1 in `CLAUDE.md`).

An organization starts from a **configuration file**, a JSON document that
sets all of this up in one step. After that, **everything is edited in the app**
under Administration — the file is only the starting point, and changing it
later does not change a running database.

## Starting a new organization

```bash
cp prisma/config/example.json prisma/config/<org>.json   # then edit it
npm run setup -- --config prisma/config/<org>.json \
  --admin-email you@example.org --admin-first-name Ada --admin-last-name Lovelace \
  --pay-anchor 2026-01-04
```

`npm run setup` loads the configuration and creates one administrator — no
demo data. Sign in as that administrator (with any sign-in method that
recognises the address) and add everyone else under Administration →
Employees, from your Microsoft 365 directory, or with `scripts/import.ts`
(`docs/GO-LIVE.md`).

`--pay-anchor` is the first day of a real pay period. Every pay period is
generated from it, and once timesheets exist it cannot be corrected, so get it
from payroll rather than guessing. Setup requires it; only the demo seed falls
back to the file's `developmentAnchorDate`.

`--mail-from` sets the address email is sent from, overriding the file's
`mailFromAddress`. An installation whose staff sign in by emailed link needs
one, or nobody — the first administrator included — can sign in. Optional
too: `--hire-date`, the administrator's (default today). Anything required and
left out is asked for when setup runs in a terminal, and setup refuses a
database that already has employees.

For a demo or development database instead, `npm run db:seed` loads the same
kind of file plus a handful of fictional staff. It reads the file named by
`SEED_CONFIG`, and `prisma/config/example.json` without it. The production
seed (`SEED_CONFIGURATION_ONLY=true`) loads a configuration with no staff and
requires `SEED_CONFIG` to be named explicitly, so the example never lands in a
real database by accident.

The file is validated before anything is written (`prisma/config/organization.ts`);
a mistake is reported with the path to the offending field.

## The example

`prisma/config/example.json` describes *Example Community Church*, a fictional
organization:

| | |
|---|---|
| Benefit year | Calendar year |
| Leave requests | Half-day increments (240 minutes); a smaller remainder may be spent |
| Timesheets | 15-minute increments |
| PTO | Standard: 10 days. 5+ Years: 15 days. Senior Staff: 20 days. All after a 90-day waiting period; up to 5 of the employee's own days roll over |
| Sick | 10 days from the hire date; up to 60 of the employee's own days roll over |
| Comp time | Earned by exempt staff from approved overtime at 1.0×; doesn't roll over, except what is earned in December, which stays usable through February |
| Pay calendar | Biweekly, paid 5 days after the period ends |
| Holidays | Eight US holidays for 2026 |
| Email | None — push and the in-app list only, until an administrator sets a sending address |
| Employee types | Pastor (salaried, PTO Senior Staff), Director (salaried, PTO 5+ Years), Associate (hourly, PTO Standard); all on Sick Standard |

## The file, section by section

All durations are **minutes**: 480 is an 8-hour day, 240 half of one.

### `organization`

| Field | Meaning |
|---|---|
| `name` | Shown in the app and in email |
| `timezone` | IANA name, e.g. `America/New_York`. Days, due dates and job dates are judged in it |
| `benefitYearStartMonth`, `benefitYearStartDay` | When allotments are granted and rollover runs. `1`, `1` is the calendar year |
| `minimumRequestIncrementMinutes` | Leave is requested in multiples of this |
| `allowSubIncrementWhenBalanceIsLower` | Lets someone spend a remainder smaller than one increment, so it isn't stranded |
| `timesheetIncrementMinutes` | Worked time on timesheets is entered in multiples of this |
| `displayUnit` | `DAYS` or `HOURS` — how balances are shown |
| `compTimeMultiplierBps` | Comp time earned per minute of approved overtime, in basis points: `10000` is 1.0×, `15000` 1.5× |
| `overtimeWeeklyThresholdMinutes` | Hourly staff's overtime begins above this many minutes in a workweek (`2400` = 40 hours) |
| `mailFromAddress` | The address email is sent from, or `null` for no email at all. How mail leaves (Graph or SMTP) is the operator's environment, not this file |

Other settings — the working week, when timesheets are due, which
notifications are on and how reminders escalate — start at sensible defaults
and are changed under Administration → Settings and → Notifications.

### `departments`

A list of names. The first two are where the demo seed puts its sample staff.

### `paySchedule`

| Field | Meaning |
|---|---|
| `name` | e.g. `Biweekly` |
| `type` | `WEEKLY`, `BIWEEKLY`, `SEMI_MONTHLY` or `MONTHLY` |
| `payDateOffsetDays` | Days from the end of a period to its pay date |
| `developmentAnchorDate` | A placeholder first period start for development. Production passes the real one (`--pay-anchor`, or `SEED_PAY_ANCHOR_DATE`) |

24 months of periods are generated ahead, and the weekly `generate-pay-periods`
job keeps it that way.

### `holidays`

`{ "date": "YYYY-MM-DD", "name": "…", "minutes": 480 }`. `minutes` is optional
and defaults to 480. Holidays are left out of leave-day counting and filled in
on timesheets. Next year's are added under Administration → Holidays.

### `leaveTypes`

| Field | Meaning |
|---|---|
| `code` | Short identifier the other sections and the import refer to, e.g. `PTO` |
| `name`, `colorHex`, `sortOrder` | How it appears |
| `countsTowardRollover` | Whether a rollover rule applies to it |
| `accruableBy` | `ALL`, `HOURLY_ONLY` or `EXEMPT_ONLY` |
| `bankOvertime` | Approved overtime is banked into this type. At most one, and it must be `EXEMPT_ONLY`: US private employers may not give non-exempt staff comp time in lieu of overtime pay |

### `policies`

A policy is how much of a leave type someone is granted. Tiers (by length of
service, say) are separate policies; an employee is moved between them by an
administrator.

| Field | Meaning |
|---|---|
| `leaveType` | A leave type `code` |
| `name` | e.g. `Standard`, `5+ Years` |
| `method` | `ANNUAL_LUMP` grants the whole year at once; `PER_PAY_PERIOD` spreads it across pay periods |
| `annualMinutes` | The year's allotment. 4800 is 10 days of 480 minutes |
| `waitingPeriodDays` | Days after the hire date before the first grant |
| `firstYearGrant` | In the hire year: `FULL_AFTER_WAITING` (the full allotment once the waiting period ends), `PRORATE`, or `NONE` |

A type with no policy, such as comp time, is only ever earned.

### `rolloverRules`

What carries into the next benefit year, one per leave type.

| `capBasis` | `capValue` means |
|---|---|
| `NONE` | Nothing carries over |
| `UNLIMITED` | Everything does |
| `FIXED_MINUTES` | Up to this many minutes, the same for everyone |
| `EMPLOYEE_DAYS` | Up to this many of the employee's *own* working days — fair to part-timers |

### `carryoverWindows`

An exception to a rollover rule: time earned between two dates stays usable
until a later one, whatever the rule says. The example keeps December's comp
time usable through February:

```json
{
  "leaveType": "COMP", "name": "December comp grace period",
  "earnedFromMonth": 12, "earnedFromDay": 1, "earnedToMonth": 12, "earnedToDay": 31,
  "usableUntilMonth": 2, "usableUntilDay": 28, "usableUntilYearOffset": 1,
  "capBasis": "UNLIMITED"
}
```

February 28 means the end of February: in a leap year it resolves to the 29th.

### `employeeTypes`

Optional. Starting profiles for new employees: choosing one when adding an
employee fills in the employment type and puts them on the type's policies
from their hire date. After that the employee's policies are their own.

```json
{
  "name": "Director", "employmentType": "SALARIED_EXEMPT",
  "policies": { "PTO": "5+ Years", "SICK": "Standard" }
}
```

| Field | Meaning |
|---|---|
| `name` | What your organization calls this kind of staff. Unique |
| `employmentType` | `HOURLY` or `SALARIED_EXEMPT` — what the new-employee form starts at |
| `policies` | Leave type `code` to the `name` of one of its policies in this file. A leave type left out gets no policy. A leave type the employment type cannot accrue is refused — no comp policy on an hourly type |

On a re-run a type is created, with its policies, only when no type of that
name exists. One that does is left exactly as an administrator may have edited
it under Administration → Employee types, defaults included; one renamed in
the app is created again under the file's name. Nothing here changes an
existing employee's policies.

