/**
 * Fixtures for the accrual tests.
 *
 * Deliberately minimal: every policy number a test depends on is written in
 * that test, not defaulted here, so a case like "120-day wait, 7200 minutes"
 * can be checked against the spreadsheet without opening another file.
 */

import type {
  CarryoverWindowInput,
  EmployeeInput,
  ExistingEntry,
  LeaveTypeInput,
  LedgerEntryKind,
  PolicyInput,
  ProposedEntry,
} from '@/lib/accrual/types'
import type { PayScheduleInput, PayScheduleType } from '@/lib/payperiods/generate'

/** A DATE column value: UTC midnight, no time-of-day. */
export function d(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`)
}

export function iso(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** One full working day, so day-based caps have something to multiply. */
export const FULL_DAY = 480

export function employee(overrides: Partial<EmployeeInput> = {}): EmployeeInput {
  return {
    id: 'emp',
    hireDate: d('2020-01-01'),
    terminationDate: null,
    standardMinutesPerDay: FULL_DAY,
    employmentType: 'SALARIED_EXEMPT',
    ...overrides,
  }
}

export function policy(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    id: 'pol',
    leaveTypeId: 'pto',
    method: 'ANNUAL_LUMP',
    annualMinutes: 7200,
    maxBalanceMinutes: null,
    waitingPeriodDays: 0,
    firstYearGrant: 'FULL_AFTER_WAITING',
    ...overrides,
  }
}

export function leaveType(overrides: Partial<LeaveTypeInput> = {}): LeaveTypeInput {
  return { id: 'pto', countsTowardRollover: true, ...overrides }
}

export function window(overrides: Partial<CarryoverWindowInput> = {}): CarryoverWindowInput {
  return {
    id: 'win',
    name: 'December comp grace period',
    earnedFromMonth: 12,
    earnedFromDay: 1,
    earnedToMonth: 12,
    earnedToDay: 31,
    usableUntilMonth: 2,
    usableUntilDay: 28,
    usableUntilYearOffset: 1,
    capBasis: 'UNLIMITED',
    capValue: 0,
    ...overrides,
  }
}

export function schedule(
  type: PayScheduleType = 'BIWEEKLY',
  anchor = '2026-01-01',
): PayScheduleInput {
  return { type, anchorDate: d(anchor), payDateOffsetDays: 5 }
}

let nextId = 0

/** A ledger row as the engine reads it. Ids are generated so order is stable. */
export function entry(
  isoDate: string,
  minutes: number,
  kind: LedgerEntryKind,
  opts: { expiresOn?: string; id?: string } = {},
): ExistingEntry {
  nextId += 1
  return {
    id: opts.id ?? `e${String(nextId).padStart(4, '0')}`,
    effectiveDate: d(isoDate),
    minutes,
    kind,
    expiresOn: opts.expiresOn ? d(opts.expiresOn) : null,
  }
}

/** Turns proposed entries into existing ones, for testing a second run. */
export function asExisting(proposed: readonly ProposedEntry[]): ExistingEntry[] {
  return proposed.map((p, i) => ({
    id: `p${String(i).padStart(4, '0')}`,
    effectiveDate: p.effectiveDate,
    minutes: p.minutes,
    kind: p.kind,
    expiresOn: p.expiresOn,
    periodKey: p.periodKey,
  }))
}

/** A readable shape for assertions: date, minutes, kind, expiry, key. */
export function rows(entries: readonly ProposedEntry[]): string[] {
  return entries.map(
    (e) =>
      `${iso(e.effectiveDate)} ${e.minutes >= 0 ? '+' : ''}${e.minutes} ${e.kind} ` +
      `exp=${e.expiresOn ? iso(e.expiresOn) : '-'} key=${e.periodKey ?? '-'}`,
  )
}
