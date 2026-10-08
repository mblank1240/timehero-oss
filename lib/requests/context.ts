/**
 * Everything needed to judge a leave request against a balance, loaded in one
 * place so submission and final approval judge it identically.
 *
 * The judging itself is pure (`assess`, over `projectEntries`); this module is
 * the I/O that feeds it.
 */

import type { Prisma, PrismaClient } from '@prisma/client'

import { balanceOf } from '@/lib/accrual/balance'
import { toUtcDay } from '@/lib/accrual/dates'
import { firstShortfall, projectEntries, type Shortfall } from '@/lib/accrual/projection'
import type {
  CarryoverWindowInput,
  EmployeeInput,
  ExistingEntry,
  PolicyInput,
  RolloverRuleInput,
} from '@/lib/accrual/types'
import { db } from '@/lib/db'
import { entriesFor } from '@/lib/ledger/entries'
import { policyInForce } from '@/lib/ledger/policies'
import type { PayScheduleInput } from '@/lib/payperiods/generate'

import type { DayInput } from './validate'

type Client = PrismaClient | Prisma.TransactionClient

export type LeaveContext = {
  employee: EmployeeInput
  leaveType: {
    id: string
    name: string
    countsTowardRollover: boolean
    allowsNegativeBalance: boolean
  }
  policy: PolicyInput | null
  rule: RolloverRuleInput | null
  windows: CarryoverWindowInput[]
  schedule: PayScheduleInput | null
  benefitYearStart: { month: number; day: number }
  /** The real ledger for this employee and type. */
  ledger: ExistingEntry[]
  /** Other pending requests' days, as the USAGE they would become. */
  holds: ExistingEntry[]
  today: Date
}

export async function loadLeaveContext(
  args: {
    employeeId: string
    leaveTypeId: string
    today: Date
    benefitYearStart: { month: number; day: number }
    /** The request being decided, which must not count as a hold on itself. */
    excludeRequestId?: string
  },
  client: Client = db,
): Promise<LeaveContext> {
  // Sequential, not Promise.all: inside a transaction every query shares one
  // connection, and node-postgres is deprecating overlapping queries on one.
  const employee = await client.employee.findUniqueOrThrow({
    where: { id: args.employeeId },
    select: {
      id: true,
      hireDate: true,
      terminationDate: true,
      standardMinutesPerDay: true,
      employmentType: true,
      paySchedule: { select: { type: true, anchorDate: true, payDateOffsetDays: true } },
    },
  })
  const leaveType = await client.leaveType.findUniqueOrThrow({
    where: { id: args.leaveTypeId },
    select: {
      id: true,
      name: true,
      countsTowardRollover: true,
      allowsNegativeBalance: true,
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
  })
  const ledger = await entriesFor(args.employeeId, args.leaveTypeId, client)
  const pending = await client.leaveRequestDay.findMany({
    where: {
      leaveRequest: {
        employeeId: args.employeeId,
        leaveTypeId: args.leaveTypeId,
        status: 'PENDING',
        ...(args.excludeRequestId ? { id: { not: args.excludeRequestId } } : {}),
      },
    },
    select: { id: true, date: true, minutes: true },
  })

  const { paySchedule, ...employeeInput } = employee
  const policy = await policyInForce(employeeInput, args.leaveTypeId, args.today, client)

  return {
    employee: employeeInput,
    leaveType: {
      id: leaveType.id,
      name: leaveType.name,
      countsTowardRollover: leaveType.countsTowardRollover,
      allowsNegativeBalance: leaveType.allowsNegativeBalance,
    },
    policy: policy?.policy ?? null,
    rule: leaveType.rolloverRule,
    windows: leaveType.carryoverWindows,
    schedule: paySchedule,
    benefitYearStart: args.benefitYearStart,
    ledger,
    holds: pending.map((day) => usage(`~hold-${day.id}`, day.date, day.minutes)),
    today: args.today,
  }
}

/** A hypothetical USAGE row, as the projection reads one. */
function usage(id: string, date: Date, minutes: number): ExistingEntry {
  return { id, effectiveDate: date, minutes: -minutes, kind: 'USAGE', expiresOn: null }
}

export type Assessment = {
  /**
   * Projected balance on the first requested day, before this request and net
   * of any other pending request dated on or before it. What the
   * stranded-balance exception compares against.
   */
  availableMinutes: number
  /** Projected balance on the last requested day, with this request taken. */
  balanceAfterMinutes: number
  /** Minutes held by other pending requests of this type. */
  pendingMinutes: number
  /** Where the balance first goes below zero, when the type does not allow it. */
  shortfall: Shortfall | null
}

/**
 * Projects the ledger forward with and without the requested days, and says
 * whether the time is there.
 *
 * The projection runs through the last date any usage lands on — this
 * request's, other pending ones', and already-approved future leave — so a
 * request that starves a later booking is caught now.
 */
export function assess(ctx: LeaveContext, days: readonly DayInput[]): Assessment {
  const requested = days
    .map((d) => usage(`~request-${d.date}`, isoToDate(d.date), d.minutes))
    .sort((a, b) => toUtcDay(a.effectiveDate) - toUtcDay(b.effectiveDate))
  if (requested.length === 0) throw new Error('assess() needs at least one day')

  const first = requested[0].effectiveDate
  const last = requested[requested.length - 1].effectiveDate

  const base = [...ctx.ledger, ...ctx.holds]
  const horizon = [...base, ...requested]
    .filter((e) => e.kind === 'USAGE')
    .reduce(
      (latest, e) => (toUtcDay(e.effectiveDate) > toUtcDay(latest) ? e.effectiveDate : latest),
      ctx.today,
    )

  const project = (entries: ExistingEntry[]) =>
    projectEntries({
      employee: ctx.employee,
      leaveType: { id: ctx.leaveType.id, countsTowardRollover: ctx.leaveType.countsTowardRollover },
      policy: ctx.policy,
      rule: ctx.rule,
      windows: ctx.windows,
      schedule: ctx.schedule,
      benefitYearStart: ctx.benefitYearStart,
      entries,
      from: ctx.today,
      through: horizon,
    })

  const without = [...base, ...project(base)]
  const withRequest = [...base, ...requested]
  const projectedWith = [...withRequest, ...project(withRequest)]

  return {
    availableMinutes: balanceOf(without, first),
    balanceAfterMinutes: balanceOf(projectedWith, last),
    pendingMinutes: ctx.holds.reduce((sum, h) => sum - h.minutes, 0),
    shortfall: ctx.leaveType.allowsNegativeBalance ? null : firstShortfall(projectedWith, first),
  }
}

export function isoToDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`)
}
