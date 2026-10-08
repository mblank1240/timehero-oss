/**
 * Opening balances: what an employee arrives with from the previous system.
 *
 * The obvious implementation — one `ADJUSTMENT` for the balance — is wrong.
 * The next accrual run would look for this year's `LUMP_GRANT`, find none,
 * and grant the whole allotment again on top of a balance that already
 * included it. The same goes for per-pay-period accrual, whose cumulative
 * target counts `PERIOD_ACCRUAL` rows and would catch the year up in one go.
 *
 * So the opening balance is posted in two parts:
 *
 *  1. The grants the engine says were due in the current benefit year by the
 *     cutover date, written exactly as the jobs would write them — same kind,
 *     same idempotency key. The jobs then find them and grant nothing twice.
 *  2. One `ADJUSTMENT` for the difference between those grants and the real
 *     balance — zero, sometimes, but always written. It absorbs everything the old system knew and this one does
 *     not: leave taken this year, last year's carry, past corrections.
 *
 * Balance as of the cutover is then exactly the figure supplied, and every
 * later job carries on from the right place.
 *
 * Pure: the caller loads the employee, the policy and any entries already on
 * the ledger, and writes what this returns.
 */

import type { PayScheduleInput } from '@/lib/payperiods/generate'

import { balanceOf } from './balance'
import { isOnOrBefore, toDateOnly, type BenefitYear } from './dates'
import { grantLump } from './grant'
import { accruePayPeriod } from './period'
import type { EmployeeInput, ExistingEntry, PolicyInput, ProposedEntry } from './types'

/**
 * The opening adjustment's idempotency key. ADJUSTMENT rows normally have a
 * null key so an administrator can post two on the same day; this one has a
 * key so the unique index refuses a second import of the same balance.
 */
export const OPENING_PERIOD_KEY = 'OPENING'

export type OpeningBalanceArgs = {
  employee: EmployeeInput
  leaveTypeId: string
  /** The policy in force on the cutover date, or null (comp time has none). */
  policy: PolicyInput | null
  /** The benefit year containing the cutover date. */
  benefitYear: BenefitYear
  /** The cutover: the balance supplied is the balance at the end of this day. */
  asOf: Date
  /** The balance the previous system reports, in minutes. */
  openingMinutes: number
  /** Optional expiry for the opening amount — carried comp time, say. */
  expiresOn?: Date | null
  /** For a per-pay-period policy: the schedule, and its periods this year. */
  schedule?: PayScheduleInput | null
  periods?: readonly { startDate: Date; endDate: Date }[]
  /** Whatever is already on the ledger for this employee and leave type. */
  entries: readonly ExistingEntry[]
  note: string
}

export type OpeningBalancePlan =
  | { status: 'already-imported' }
  | {
      status: 'planned'
      /** Grants the jobs would have written by the cutover. */
      grants: ProposedEntry[]
      /**
       * Always written, even at zero minutes: it is the record that this
       * balance was imported, and its key is what refuses a second import.
       */
      adjustment: ProposedEntry
    }

export function planOpeningBalance(args: OpeningBalanceArgs): OpeningBalancePlan {
  const { employee, leaveTypeId, policy, benefitYear, asOf, entries } = args

  if (entries.some((e) => e.kind === 'ADJUSTMENT' && e.periodKey === OPENING_PERIOD_KEY)) {
    return { status: 'already-imported' }
  }

  const written = new Set(entries.map((e) => `${e.kind}/${e.periodKey ?? ''}`))
  const grants: ProposedEntry[] = []
  // Grants are fed back in as they are planned: a per-period target reads the
  // accruals before it, and the ceiling reads the balance.
  const working: ExistingEntry[] = [...entries]

  const keep = (entry: ProposedEntry | null) => {
    if (!entry || !isOnOrBefore(entry.effectiveDate, asOf)) return
    if (written.has(`${entry.kind}/${entry.periodKey ?? ''}`)) return
    grants.push(entry)
    working.push({ ...entry, id: `planned-${grants.length}` })
  }

  if (policy?.method === 'ANNUAL_LUMP') {
    keep(grantLump(employee, policy, benefitYear))
  } else if (policy?.method === 'PER_PAY_PERIOD' && args.schedule) {
    for (const period of args.periods ?? []) {
      if (!isOnOrBefore(period.endDate, asOf)) continue
      keep(
        accruePayPeriod({
          employee,
          policy,
          benefitYear,
          schedule: args.schedule,
          period,
          entries: working,
        }),
      )
    }
  }

  const difference = args.openingMinutes - balanceOf(working, asOf)

  return {
    status: 'planned',
    grants,
    adjustment: {
      employeeId: employee.id,
      leaveTypeId,
      effectiveDate: toDateOnly(asOf),
      minutes: difference,
      kind: 'ADJUSTMENT',
      expiresOn: args.expiresOn ?? null,
      periodKey: OPENING_PERIOD_KEY,
      note: args.note,
    },
  }
}
