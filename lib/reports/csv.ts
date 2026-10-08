/**
 * The reports as CSV rows. Pure.
 *
 * Every duration is written twice, as hours to two places for a person and
 * as whole minutes for a machine — the same convention as the timesheet
 * exports. Days are not written: what a day is differs per employee.
 */

import type { CsvCell } from '@/lib/csv'

import {
  FORFEIT_REASON_LABEL,
  type BalanceRow,
  type ForfeitReason,
  type LeaveDay,
  type LeaveSummaryRow,
  type LedgerLine,
  type ReportEmployee,
} from './rows'

const iso = (date: Date) => date.toISOString().slice(0, 10)
/** A number, not a string: the formula guard in lib/csv would mark a negative string. */
const hours = (minutes: number) => Math.round((minutes / 60) * 100) / 100
const who = (e: ReportEmployee): CsvCell[] => [e.lastName, e.firstName, e.email]
const WHO = ['Last name', 'First name', 'Email']

export function balancesCsv(
  asOf: Date,
  leaveTypes: readonly { id: string; name: string }[],
  rows: readonly BalanceRow[],
): CsvCell[][] {
  return [
    [
      'As of',
      ...WHO,
      ...leaveTypes.map((t) => `${t.name} hours`),
      ...leaveTypes.map((t) => `${t.name} minutes`),
    ],
    ...rows.map((r) => {
      const minutes = leaveTypes.map((t) => r.minutes.get(t.id) ?? 0)
      return [iso(asOf), ...who(r.employee), ...minutes.map(hours), ...minutes]
    }),
  ]
}

export function leaveSummaryCsv(
  range: { from: Date; to: Date },
  rows: readonly LeaveSummaryRow[],
): CsvCell[][] {
  return [
    ['From', 'To', ...WHO, 'Leave type', 'Days taken', 'Hours', 'Minutes'],
    ...rows.map((r) => [
      iso(range.from),
      iso(range.to),
      ...who(r.employee),
      r.leaveType.name,
      r.days,
      hours(r.minutes),
      r.minutes,
    ]),
  ]
}

export function leaveDaysCsv(days: readonly LeaveDay[]): CsvCell[][] {
  return [
    ['Date', ...WHO, 'Leave type', 'Hours', 'Minutes'],
    ...days.map((d) => [
      iso(d.date),
      ...who(d.employee),
      d.leaveType.name,
      hours(d.minutes),
      d.minutes,
    ]),
  ]
}

export function forfeituresCsv(
  rows: readonly {
    date: Date
    employee: ReportEmployee
    leaveType: { name: string }
    reason: ForfeitReason
    minutes: number
    note: string | null
  }[],
): CsvCell[][] {
  return [
    ['Date', ...WHO, 'Leave type', 'Reason', 'Hours forfeited', 'Minutes forfeited', 'Note'],
    ...rows.map((r) => [
      iso(r.date),
      ...who(r.employee),
      r.leaveType.name,
      FORFEIT_REASON_LABEL[r.reason],
      hours(r.minutes),
      r.minutes,
      r.note,
    ]),
  ]
}

export function ledgerCsv(employee: ReportEmployee, lines: readonly LedgerLine[]): CsvCell[][] {
  return [
    [
      ...WHO,
      'Date',
      'Leave type',
      'Kind',
      'Hours',
      'Minutes',
      'Balance hours',
      'Balance minutes',
      'Expires',
      'Note',
      'Entered by',
    ],
    ...lines.map((l) => [
      ...who(employee),
      iso(l.date),
      l.leaveType.name,
      l.kind,
      hours(l.minutes),
      l.minutes,
      hours(l.balance),
      l.balance,
      l.expiresOn ? iso(l.expiresOn) : '',
      l.note,
      l.createdBy ?? '',
    ]),
  ]
}

/** `ledger-2026-10-07-okafor-sam.csv` — plain ASCII, safe anywhere. */
export function slug(...parts: string[]): string {
  return parts
    .join('-')
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
