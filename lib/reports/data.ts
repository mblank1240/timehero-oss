/**
 * The reads behind the reports. Every figure is `SUM(minutes)` over ledger
 * rows or approved request days, computed here and never stored (rule 2).
 * The page and the CSV export call the same function, so they cannot differ.
 */

import { db } from '@/lib/db'

import type { DateRange } from './filters'
import {
  forfeitReason,
  summarise,
  type BalanceRow,
  type LeaveDay,
  type LedgerLine,
} from './rows'

const employeeFields = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  standardMinutesPerDay: true,
} as const

const byName = { orderBy: [{ lastName: 'asc' as const }, { firstName: 'asc' as const }] }

export async function reportLeaveTypes() {
  return db.leaveType.findMany({
    select: { id: true, name: true, isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  })
}

// ---------------------------------------------------------------------------
// Balances as of a date
// ---------------------------------------------------------------------------

/**
 * Every employee employed on `asOf`, with each leave type's balance on that
 * date. Someone who has since left still appears for a date they were here.
 * Types nobody holds a balance in are left out of `leaveTypes`.
 */
export async function balancesReport(asOf: Date) {
  const [employees, sums, types] = await Promise.all([
    db.employee.findMany({
      where: {
        hireDate: { lte: asOf },
        OR: [{ terminationDate: null }, { terminationDate: { gte: asOf } }],
      },
      select: employeeFields,
      ...byName,
    }),
    db.ledgerEntry.groupBy({
      by: ['employeeId', 'leaveTypeId'],
      where: { effectiveDate: { lte: asOf } },
      _sum: { minutes: true },
    }),
    reportLeaveTypes(),
  ])

  const held = new Set<string>()
  const byEmployee = new Map<string, Map<string, number>>()
  for (const s of sums) {
    const minutes = s._sum.minutes ?? 0
    if (!byEmployee.has(s.employeeId)) byEmployee.set(s.employeeId, new Map())
    byEmployee.get(s.employeeId)!.set(s.leaveTypeId, minutes)
    if (minutes !== 0) held.add(s.leaveTypeId)
  }

  return {
    leaveTypes: types.filter((t) => held.has(t.id) || t.isActive),
    rows: employees.map<BalanceRow>((employee) => ({
      employee,
      minutes: byEmployee.get(employee.id) ?? new Map(),
    })),
  }
}

// ---------------------------------------------------------------------------
// Leave taken
// ---------------------------------------------------------------------------

/**
 * Approved leave days in the range, from the requests themselves — the same
 * source as the history page, so a day given back in a later year is not
 * counted twice. Leave recorded only as an administrator's ledger adjustment
 * is not a request day and does not appear.
 */
export async function leaveTakenReport(range: DateRange, leaveTypeId: string | null) {
  const days = await db.leaveRequestDay.findMany({
    where: {
      date: { gte: range.from, lte: range.to },
      leaveRequest: { status: 'APPROVED', ...(leaveTypeId ? { leaveTypeId } : {}) },
    },
    select: {
      date: true,
      minutes: true,
      leaveRequest: {
        select: {
          id: true,
          employee: { select: employeeFields },
          leaveType: { select: { id: true, name: true } },
        },
      },
    },
  })

  const rows: LeaveDay[] = days
    .map((d) => ({
      date: d.date,
      minutes: d.minutes,
      employee: d.leaveRequest.employee,
      leaveType: d.leaveRequest.leaveType,
      requestId: d.leaveRequest.id,
    }))
    .sort(
      (a, b) =>
        a.employee.lastName.localeCompare(b.employee.lastName) ||
        a.employee.firstName.localeCompare(b.employee.firstName) ||
        a.date.getTime() - b.date.getTime() ||
        a.leaveType.name.localeCompare(b.leaveType.name),
    )

  return { days: rows, summary: summarise(rows) }
}

// ---------------------------------------------------------------------------
// Forfeitures
// ---------------------------------------------------------------------------

export async function forfeitureReport(range: DateRange, leaveTypeId: string | null) {
  const entries = await db.ledgerEntry.findMany({
    where: {
      kind: 'FORFEIT',
      effectiveDate: { gte: range.from, lte: range.to },
      ...(leaveTypeId ? { leaveTypeId } : {}),
    },
    select: {
      id: true,
      effectiveDate: true,
      minutes: true,
      periodKey: true,
      note: true,
      employee: { select: employeeFields },
      leaveType: { select: { id: true, name: true } },
    },
    orderBy: [{ effectiveDate: 'asc' }, { id: 'asc' }],
  })

  return entries
    .map((e) => ({
      id: e.id,
      date: e.effectiveDate,
      // A forfeit is stored negative; the report states what was lost.
      minutes: -e.minutes,
      reason: forfeitReason(e.periodKey),
      note: e.note,
      employee: e.employee,
      leaveType: e.leaveType,
    }))
    .sort(
      (a, b) =>
        a.date.getTime() - b.date.getTime() ||
        a.employee.lastName.localeCompare(b.employee.lastName) ||
        a.employee.firstName.localeCompare(b.employee.firstName),
    )
}

// ---------------------------------------------------------------------------
// One employee's ledger
// ---------------------------------------------------------------------------

/**
 * Every entry for one employee, oldest first, with each type's running
 * balance. The balance after the last line of a type is that type's balance.
 */
export async function employeeLedgerReport(employeeId: string, leaveTypeId: string | null) {
  const entries = await db.ledgerEntry.findMany({
    where: { employeeId, ...(leaveTypeId ? { leaveTypeId } : {}) },
    select: {
      id: true,
      effectiveDate: true,
      minutes: true,
      kind: true,
      expiresOn: true,
      note: true,
      createdAt: true,
      leaveType: { select: { id: true, name: true } },
      createdBy: { select: { firstName: true, lastName: true } },
    },
    orderBy: [{ effectiveDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  })

  const running = new Map<string, number>()
  return entries.map<LedgerLine>((e) => {
    const balance = (running.get(e.leaveType.id) ?? 0) + e.minutes
    running.set(e.leaveType.id, balance)
    return {
      id: e.id,
      date: e.effectiveDate,
      leaveType: e.leaveType,
      kind: e.kind,
      minutes: e.minutes,
      balance,
      expiresOn: e.expiresOn,
      note: e.note,
      createdBy: e.createdBy ? `${e.createdBy.firstName} ${e.createdBy.lastName}` : null,
    }
  })
}

export async function reportEmployees() {
  return db.employee.findMany({
    select: { ...employeeFields, isActive: true },
    ...byName,
  })
}
