/**
 * Resolving who accrues what, on a given date.
 *
 * The jobs need three things the engine deliberately does not know how to find:
 * which employees are in scope, which policy each of them is on today, and
 * what their allotment actually is once a per-employee override is applied.
 * Everything here is a query; none of it decides anything.
 */

import type { Prisma, PrismaClient } from '@prisma/client'

import type { EmployeeInput, LeaveTypeInput, PolicyInput } from '@/lib/accrual/types'
import { db } from '@/lib/db'

type Client = PrismaClient | Prisma.TransactionClient

export type PolicyInForce = {
  assignmentId: string
  policy: PolicyInput
  leaveType: LeaveTypeInput & { code: string; name: string }
}

export type AccrualSubject = {
  employee: EmployeeInput
  payScheduleId: string | null
  policies: PolicyInForce[]
}

/**
 * Employees employed on `onDate`, with the policies in force for them.
 *
 * `isActive` and `terminationDate` are different facts and the distinction
 * matters here. `isActive` governs sign-in and has no history — it says
 * whether the account works *now*. `terminationDate` is the historical fact
 * about employment, and it is the one a job acting on a past date has to use,
 * or a backfill would skip everybody who has left since.
 *
 * So: still employed and active, or holding a termination date on or after the
 * date being processed. Someone deactivated with no termination date is out,
 * which is what an administrator pressing "deactivate" means. A termination
 * date on `onDate` itself counts as employed — the last day worked is a day
 * worked.
 */
export async function subjectsForAccrual(
  onDate: Date,
  client: Client = db,
): Promise<AccrualSubject[]> {
  const employees = await client.employee.findMany({
    where: {
      OR: [{ isActive: true, terminationDate: null }, { terminationDate: { gte: onDate } }],
    },
    select: {
      id: true,
      hireDate: true,
      terminationDate: true,
      standardMinutesPerDay: true,
      employmentType: true,
      payScheduleId: true,
      leavePolicies: {
        where: assignmentsOn(onDate),
        orderBy: { effectiveFrom: 'desc' },
        select: ASSIGNMENT_SELECT,
      },
    },
    orderBy: { id: 'asc' },
  })

  return employees.map((row) => {
    const employee: EmployeeInput = {
      id: row.id,
      hireDate: row.hireDate,
      terminationDate: row.terminationDate,
      standardMinutesPerDay: row.standardMinutesPerDay,
      employmentType: row.employmentType,
    }

    // At most one policy per leave type per date. The schema cannot express
    // that, so the most recently effective assignment wins and the rest are
    // ignored rather than double-granting.
    const byLeaveType = new Map<string, PolicyInForce>()

    for (const assignment of row.leavePolicies) {
      const resolved = toPolicyInForce(assignment, employee.employmentType)
      if (resolved && !byLeaveType.has(resolved.leaveType.id)) {
        byLeaveType.set(resolved.leaveType.id, resolved)
      }
    }

    return { employee, payScheduleId: row.payScheduleId, policies: [...byLeaveType.values()] }
  })
}

/**
 * The policy in force for one employee and one leave type on `onDate`, by the
 * same rules the accrual jobs apply — so a projected balance and the balance
 * the jobs later write are working from the same policy.
 */
export async function policyInForce(
  employee: { id: string; employmentType: 'HOURLY' | 'SALARIED_EXEMPT' },
  leaveTypeId: string,
  onDate: Date,
  client: Client = db,
): Promise<PolicyInForce | null> {
  const assignments = await client.employeeLeavePolicy.findMany({
    where: { employeeId: employee.id, leavePolicy: { leaveTypeId }, ...assignmentsOn(onDate) },
    orderBy: { effectiveFrom: 'desc' },
    select: ASSIGNMENT_SELECT,
  })

  for (const assignment of assignments) {
    const resolved = toPolicyInForce(assignment, employee.employmentType)
    if (resolved) return resolved
  }
  return null
}

function assignmentsOn(onDate: Date) {
  return {
    effectiveFrom: { lte: onDate },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: onDate } }],
  }
}

const ASSIGNMENT_SELECT = {
  id: true,
  annualMinutesOverride: true,
  leavePolicy: {
    select: {
      id: true,
      leaveTypeId: true,
      method: true,
      annualMinutes: true,
      maxBalanceMinutes: true,
      waitingPeriodDays: true,
      firstYearGrant: true,
      isActive: true,
      leaveType: {
        select: {
          id: true,
          code: true,
          name: true,
          countsTowardRollover: true,
          accruableBy: true,
          isActive: true,
        },
      },
    },
  },
} as const

type AssignmentRow = Prisma.EmployeeLeavePolicyGetPayload<{ select: typeof ASSIGNMENT_SELECT }>

/** Null when the policy or its type is inactive, or the employee cannot hold it. */
function toPolicyInForce(
  assignment: AssignmentRow,
  employmentType: 'HOURLY' | 'SALARIED_EXEMPT',
): PolicyInForce | null {
  const policy = assignment.leavePolicy
  const leaveType = policy.leaveType

  if (!policy.isActive || !leaveType.isActive) return null
  if (!accruableBy(leaveType.accruableBy, employmentType)) return null

  return {
    assignmentId: assignment.id,
    policy: {
      id: policy.id,
      leaveTypeId: policy.leaveTypeId,
      method: policy.method,
      // The override is the whole point of the assignment row: tenure
      // tiers are per-employee figures on a shared policy.
      annualMinutes: assignment.annualMinutesOverride ?? policy.annualMinutes,
      maxBalanceMinutes: policy.maxBalanceMinutes,
      waitingPeriodDays: policy.waitingPeriodDays,
      firstYearGrant: policy.firstYearGrant,
    },
    leaveType: {
      id: leaveType.id,
      code: leaveType.code,
      name: leaveType.name,
      countsTowardRollover: leaveType.countsTowardRollover,
    },
  }
}

/**
 * Rule 4 in CLAUDE.md in its general form. `EXEMPT_ONLY` exists because the
 * FLSA bars private employers from giving non-exempt staff comp time in lieu
 * of overtime pay; `HOURLY_ONLY` is its mirror for anything the church ever
 * decides only hourly staff receive.
 */
export function accruableBy(
  basis: 'ALL' | 'HOURLY_ONLY' | 'EXEMPT_ONLY',
  employmentType: 'HOURLY' | 'SALARIED_EXEMPT',
): boolean {
  switch (basis) {
    case 'ALL':
      return true
    case 'HOURLY_ONLY':
      return employmentType === 'HOURLY'
    case 'EXEMPT_ONLY':
      return employmentType === 'SALARIED_EXEMPT'
  }
}

/** Every leave type that can hold a balance, for the rollover and expiry jobs. */
export async function rolloverConfiguration() {
  return db.leaveType.findMany({
    where: { isActive: true },
    select: {
      id: true,
      code: true,
      name: true,
      countsTowardRollover: true,
      rolloverRule: {
        select: { capBasis: true, capValue: true, carriedExpiresAfterDays: true },
      },
      carryoverWindows: {
        where: { isActive: true },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          earnedFromMonth: true,
          earnedFromDay: true,
          earnedToMonth: true,
          earnedToDay: true,
          usableUntilMonth: true,
          usableUntilDay: true,
          usableUntilYearOffset: true,
          capBasis: true,
          capValue: true,
        },
      },
    },
    orderBy: { sortOrder: 'asc' },
  })
}

/** The org row, which every job needs for the benefit-year boundary. */
export async function orgSettingsOrThrow() {
  const settings = await db.orgSettings.findUnique({ where: { id: 1 } })
  if (!settings) {
    throw new Error('Org settings have not been configured. Run the seed or the admin setup.')
  }
  return settings
}
