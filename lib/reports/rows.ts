/**
 * The shapes the reports are made of, and the pure rules over them. Kept
 * apart from the queries in `data.ts` so they are tested without a database.
 */

import type { LedgerEntryKind } from '@prisma/client'

export type ReportEmployee = {
  id: string
  firstName: string
  lastName: string
  email: string
  standardMinutesPerDay: number
}

export type BalanceRow = { employee: ReportEmployee; minutes: Map<string, number> }

export type LeaveDay = {
  date: Date
  minutes: number
  employee: ReportEmployee
  leaveType: { id: string; name: string }
  requestId: string
}

export type LeaveSummaryRow = {
  employee: ReportEmployee
  leaveType: { id: string; name: string }
  days: number
  minutes: number
}

/** One row per employee and leave type: how many days, and how much time. */
export function summarise(days: readonly LeaveDay[]): LeaveSummaryRow[] {
  const rows = new Map<string, LeaveSummaryRow>()
  for (const d of days) {
    const key = `${d.employee.id}:${d.leaveType.id}`
    const row = rows.get(key) ?? {
      employee: d.employee,
      leaveType: d.leaveType,
      days: 0,
      minutes: 0,
    }
    row.days += 1
    row.minutes += d.minutes
    rows.set(key, row)
  }
  return [...rows.values()]
}

export type ForfeitReason = 'ROLLOVER' | 'EXPIRY' | 'OTHER'

/** Why a FORFEIT was written, from the key the job gave it. */
export function forfeitReason(periodKey: string | null): ForfeitReason {
  if (periodKey?.endsWith('-EXPIRY')) return 'EXPIRY'
  if (periodKey?.includes('-ROLLOVER')) return 'ROLLOVER'
  return 'OTHER'
}

export const FORFEIT_REASON_LABEL: Record<ForfeitReason, string> = {
  ROLLOVER: 'Year-end rollover',
  EXPIRY: 'Expired',
  OTHER: 'Other',
}

export const LEDGER_KIND_LABEL: Record<LedgerEntryKind, string> = {
  LUMP_GRANT: 'Annual grant',
  PERIOD_ACCRUAL: 'Accrual',
  ROLLOVER_IN: 'Carried over',
  FORFEIT: 'Forfeited',
  USAGE: 'Leave taken',
  USAGE_REVERSAL: 'Leave given back',
  COMP_EARNED: 'Comp earned',
  ADJUSTMENT: 'Adjustment',
}

export type LedgerLine = {
  id: string
  date: Date
  leaveType: { id: string; name: string }
  kind: LedgerEntryKind
  minutes: number
  /** That leave type's balance after this entry. */
  balance: number
  expiresOn: Date | null
  note: string | null
  createdBy: string | null
}
