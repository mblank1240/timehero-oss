/**
 * The shapes the accrual engine works in.
 *
 * Every function in `lib/accrual/` is pure: it takes plain data and returns
 * the ledger entries it believes should exist, without writing anything. That
 * is what lets the hard parts — the November-hire grant date, the rollover
 * forfeit, the December comp window — be tested against hand-checked figures
 * with no database in the way. Persisting the result, and doing it
 * idempotently, is the service layer's job (`lib/ledger/`).
 *
 * These types mirror Prisma's rows but are declared here rather than imported
 * from `@prisma/client`, so the engine stays loadable in a unit test and a
 * caller can hand it a hypothetical employee that does not exist.
 */

export type LedgerEntryKind =
  | 'LUMP_GRANT'
  | 'PERIOD_ACCRUAL'
  | 'ROLLOVER_IN'
  | 'FORFEIT'
  | 'USAGE'
  | 'USAGE_REVERSAL'
  | 'COMP_EARNED'
  | 'ADJUSTMENT'

export type AccrualMethod = 'ANNUAL_LUMP' | 'PER_PAY_PERIOD'
export type FirstYearGrant = 'FULL_AFTER_WAITING' | 'PRORATE' | 'NONE'
export type CapBasis = 'NONE' | 'UNLIMITED' | 'FIXED_MINUTES' | 'EMPLOYEE_DAYS'
export type EmploymentType = 'HOURLY' | 'SALARIED_EXEMPT'

/** The parts of an `Employee` the engine needs. */
export type EmployeeInput = {
  id: string
  hireDate: Date
  /** Null while employed. Nothing accrues on or after this date. */
  terminationDate: Date | null
  /** What "a day" means for this person — drives `EMPLOYEE_DAYS` caps. */
  standardMinutesPerDay: number
  employmentType: EmploymentType
}

/**
 * A `LeavePolicy` with the employee's assignment already applied, so the
 * engine never has to decide which allotment wins.
 */
export type PolicyInput = {
  id: string
  leaveTypeId: string
  method: AccrualMethod
  /** `annualMinutesOverride ?? policy.annualMinutes`, resolved by the caller. */
  annualMinutes: number
  /** Accrual pauses at this balance. Null means no ceiling. */
  maxBalanceMinutes: number | null
  waitingPeriodDays: number
  firstYearGrant: FirstYearGrant
}

/** The parts of a `LeaveType` that affect what survives a year boundary. */
export type LeaveTypeInput = {
  id: string
  /** False means the balance does not survive at all, before any cap. */
  countsTowardRollover: boolean
}

export type RolloverRuleInput = {
  capBasis: CapBasis
  /** Minutes when `FIXED_MINUTES`, a day count when `EMPLOYEE_DAYS`. */
  capValue: number
  /** Carried time expires this many days into the new year. Null never does. */
  carriedExpiresAfterDays: number | null
}

export type CarryoverWindowInput = {
  id: string
  name: string
  earnedFromMonth: number
  earnedFromDay: number
  earnedToMonth: number
  earnedToDay: number
  usableUntilMonth: number
  usableUntilDay: number
  usableUntilYearOffset: number
  capBasis: CapBasis
  capValue: number
}

/** A ledger row as the engine reads it. */
export type ExistingEntry = {
  id: string
  effectiveDate: Date
  /** Signed: grants positive, usage and forfeits negative. */
  minutes: number
  kind: LedgerEntryKind
  expiresOn: Date | null
  periodKey?: string | null
}

/**
 * A ledger row the engine believes should exist. `periodKey` is the
 * idempotency key — a null one means the entry is not job-written and may
 * legitimately repeat.
 */
export type ProposedEntry = {
  employeeId: string
  leaveTypeId: string
  effectiveDate: Date
  minutes: number
  kind: LedgerEntryKind
  expiresOn: Date | null
  periodKey: string | null
  note?: string
  sourceType?: string
  sourceId?: string
}

/** A single grant and how much of it is left — see `lotBalances`. */
export type Lot = {
  /** The id of the `LedgerEntry` that created it. */
  entryId: string
  effectiveDate: Date
  expiresOn: Date | null
  kind: LedgerEntryKind
  /** What the grant was worth when written. */
  grantedMinutes: number
  /** What is left of it after consumption, never below zero. */
  remainingMinutes: number
}
