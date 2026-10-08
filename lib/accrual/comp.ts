/**
 * Comp time: what an approved overtime log banks.
 *
 * Usually one `COMP_EARNED` entry dated on the day the time was worked, at the
 * org multiplier. The hard case is a log approved after the benefit year it
 * was worked in has closed — December overtime signed off in January. That
 * year's rollover has already run on the balance as it stood, so writing the
 * time back into the closed year would carry it past the rollover with no
 * forfeit to match (the stale-rollover hazard in docs/ROADMAP.md): comp from
 * November would become permanent.
 *
 * Instead the rollover is asked what it *would* have done had the time been
 * on the books, by running it twice — with the overtime and without — and the
 * difference is banked on the new year's first day with the expiry the
 * rollover would have given it. December comp lands with its February
 * expiry; November comp lands as nothing, exactly as if it had been approved
 * on time and forfeited on 1 January.
 *
 * Pure. The service layer writes the returned entries.
 */

import { addDays, toUtcDay, type BenefitYear } from './dates'
import { runRollover } from './rollover'
import type {
  CarryoverWindowInput,
  EmployeeInput,
  ExistingEntry,
  LeaveTypeInput,
  ProposedEntry,
  RolloverRuleInput,
} from './types'

export const BPS_PER_UNIT = 10_000

/**
 * Minutes worked at a multiplier in basis points, to the nearest minute with
 * a half rounding up. 15 minutes at 1.5× is 23, not 22: the employee worked
 * the time, so the odd half-minute goes their way.
 */
export function compMinutes(workedMinutes: number, multiplierBps: number): number {
  return Math.floor((workedMinutes * multiplierBps + BPS_PER_UNIT / 2) / BPS_PER_UNIT)
}

export type CompPlanArgs = {
  log: { id: string; employeeId: string; date: Date; minutes: number }
  /** The comp leave type the time is banked into. */
  leaveTypeId: string
  multiplierBps: number
  /** `OrgSettings.compExpiresAfterDays`. Null never expires on its own. */
  expiresAfterDays: number | null
  /** The benefit year containing today. */
  currentYear: BenefitYear
  /** The one before it — the only closed year a log may still be approved into. */
  previousYear: BenefitYear

  // What the rollover needs, for a log worked in a closed year.
  employee: EmployeeInput
  leaveType: LeaveTypeInput
  rule: RolloverRuleInput | null
  windows: readonly CarryoverWindowInput[]
  /** Every ledger entry for this employee and the comp type. */
  entries: readonly ExistingEntry[]
}

export type CompPlan = {
  /** `minutes` at the multiplier, before any rollover. */
  grossMinutes: number
  /** What is actually banked: the sum of `entries`. */
  earnedMinutes: number
  entries: ProposedEntry[]
  /**
   * Set when less than the gross is banked, saying why — so the approver sees
   * it before deciding and the employee sees it afterwards.
   */
  explanation: string | null
}

export const OVERTIME_SOURCE = 'OvertimeLog'

const iso = (date: Date) => date.toISOString().slice(0, 10)

export function planCompEarned(args: CompPlanArgs): CompPlan {
  const { log, currentYear, previousYear } = args
  const gross = compMinutes(log.minutes, args.multiplierBps)
  const ownExpiry =
    args.expiresAfterDays === null ? null : addDays(log.date, args.expiresAfterDays)

  const base = {
    employeeId: log.employeeId,
    leaveTypeId: args.leaveTypeId,
    kind: 'COMP_EARNED' as const,
    sourceType: OVERTIME_SOURCE,
    sourceId: log.id,
  }

  if (gross <= 0) {
    return { grossMinutes: 0, earnedMinutes: 0, entries: [], explanation: null }
  }

  const day = toUtcDay(log.date)

  // The common case: worked this benefit year, banked on the day it was worked.
  if (day >= toUtcDay(currentYear.start)) {
    return {
      grossMinutes: gross,
      earnedMinutes: gross,
      entries: [
        {
          ...base,
          effectiveDate: log.date,
          minutes: gross,
          expiresOn: ownExpiry,
          // Under the log's row lock this is already written once; the key
          // makes the database refuse a second set whatever the code does.
          periodKey: `OT-${log.id}`,
          note: `Overtime worked ${iso(log.date)}`,
        },
      ],
      explanation: null,
    }
  }

  // Two rollovers have passed. Nothing carries through two years.
  if (day < toUtcDay(previousYear.start)) {
    return {
      grossMinutes: gross,
      earnedMinutes: 0,
      entries: [],
      explanation: `Worked before the ${previousYear.label} benefit year, so two rollovers have passed and none of it would have carried.`,
    }
  }

  // Worked in the year that has just closed: ask the rollover.
  const hypothetical: ExistingEntry = {
    id: `~overtime-${log.id}`,
    effectiveDate: log.date,
    minutes: gross,
    kind: 'COMP_EARNED',
    expiresOn: ownExpiry,
  }

  const rollover = (entries: readonly ExistingEntry[]) =>
    runRollover({
      employee: args.employee,
      leaveType: args.leaveType,
      rule: args.rule,
      windows: args.windows,
      policy: null,
      entries,
      closingYear: previousYear,
      newYear: currentYear,
    }).entries.filter((e) => e.kind === 'ROLLOVER_IN')

  const carried = carryDelta(rollover(args.entries), rollover([...args.entries, hypothetical]))
  const earned = carried.reduce((sum, c) => sum + c.minutes, 0)

  const entries: ProposedEntry[] = carried.map((c, index) => ({
    ...base,
    effectiveDate: currentYear.start,
    minutes: c.minutes,
    expiresOn: earlier(c.expiresOn, ownExpiry),
    periodKey: carried.length === 1 ? `OT-${log.id}` : `OT-${log.id}-${index + 1}`,
    note: `Overtime worked ${iso(log.date)}, approved after the ${currentYear.label} rollover; carried as that rollover would have carried it`,
  }))

  return {
    grossMinutes: gross,
    earnedMinutes: earned,
    entries,
    explanation:
      earned < gross
        ? `Worked in the ${previousYear.label} benefit year, which has closed. Its rollover would have kept ${earned} of the ${gross} minutes, so that is what is banked.`
        : null,
  }
}

type Carry = { expiresOn: Date | null; minutes: number }

const expiryKey = (date: Date | null) => (date ? toUtcDay(date) : Number.POSITIVE_INFINITY)

/**
 * The extra carry the overtime produces, grouped by expiry, soonest first.
 *
 * Adding a lot can shift carry between sources — a capped window may hand
 * some of its share to the base rule — so a group can come out negative.
 * The total is what matters; a shortfall is taken from the latest-expiring
 * group first, which leaves the employee holding the time that lasts longest
 * only when it is genuinely theirs.
 */
function carryDelta(without: readonly ProposedEntry[], withOvertime: readonly ProposedEntry[]): Carry[] {
  const groups = new Map<number, Carry>()
  const add = (entries: readonly ProposedEntry[], sign: 1 | -1) => {
    for (const entry of entries) {
      const key = expiryKey(entry.expiresOn)
      const group = groups.get(key) ?? { expiresOn: entry.expiresOn, minutes: 0 }
      group.minutes += sign * entry.minutes
      groups.set(key, group)
    }
  }
  add(withOvertime, 1)
  add(without, -1)

  const sorted = [...groups.entries()].sort(([a], [b]) => a - b).map(([, g]) => g)
  let owed = -sorted.filter((g) => g.minutes < 0).reduce((sum, g) => sum + g.minutes, 0)
  const positive = sorted.filter((g) => g.minutes > 0)

  for (let i = positive.length - 1; i >= 0 && owed > 0; i -= 1) {
    const taken = Math.min(positive[i].minutes, owed)
    positive[i].minutes -= taken
    owed -= taken
  }

  return positive.filter((g) => g.minutes > 0)
}

function earlier(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b
  if (b === null) return a
  return toUtcDay(a) <= toUtcDay(b) ? a : b
}
