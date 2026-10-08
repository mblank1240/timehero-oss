'use server'

import { revalidatePath } from 'next/cache'

import { writeAudit } from '@/lib/audit'
import { ForbiddenError, requireAdminOrThrow } from '@/lib/authz'
import { db } from '@/lib/db'
import type { ActionResult } from '@/lib/employees/actions'

import { accruableBy } from './policies'
import { adjustmentInput } from './schema'

export type { ActionResult }

function fail(error: string, fieldErrors?: Record<string, string[]>): ActionResult {
  return { ok: false, error, fieldErrors }
}

/**
 * Posts a manual `ADJUSTMENT` entry.
 *
 * The ledger is append-only, so this is how a correction is made: a new signed
 * entry, never an edit to an existing one. It is admin-only, it always carries
 * a reason, and it always writes an audit row — rule 9.
 *
 * An adjustment may legitimately take a balance negative (correcting an
 * over-grant does exactly that), so the balance is reported back rather than
 * blocked. An admin who did not mean it posts the opposite entry.
 */
export async function createAdjustment(
  _previousState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const actor = await requireAdminOrThrow()

    const parsed = adjustmentInput.safeParse(Object.fromEntries(formData))
    if (!parsed.success) {
      return fail('Please correct the errors below.', parsed.error.flatten().fieldErrors)
    }

    const { employeeId, leaveTypeId, effectiveDate, minutes, reason } = parsed.data

    // Nobody corrects their own balance; another administrator posts it, so
    // every adjustment has a second person behind it.
    if (employeeId === actor.id) {
      return fail('You cannot adjust your own balance.', {
        employeeId: ['Another administrator must post this adjustment.'],
      })
    }

    const [employee, leaveType] = await Promise.all([
      db.employee.findUnique({
        where: { id: employeeId },
        select: { id: true, employmentType: true },
      }),
      db.leaveType.findUnique({
        where: { id: leaveTypeId },
        select: { id: true, name: true, accruableBy: true },
      }),
    ])

    if (!employee) return fail('That employee no longer exists.')
    if (!leaveType) return fail('That leave type no longer exists.')

    // Rule 4 in CLAUDE.md, at the one boundary that could otherwise go round
    // it. The database trigger only fires on `kind = 'COMP_EARNED'`, so
    // without this an administrator could hand an hourly employee comp time
    // as an ADJUSTMENT — which is the wage-and-hour liability the rule exists
    // to prevent, just spelled differently.
    if (!accruableBy(leaveType.accruableBy, employee.employmentType)) {
      return fail(
        `${leaveType.name} cannot be held by a ${
          employee.employmentType === 'HOURLY' ? 'hourly' : 'salaried exempt'
        } employee.`,
        { leaveTypeId: ['This leave type is not available to this employee.'] },
      )
    }

    await db.$transaction(async (tx) => {
      const created = await tx.ledgerEntry.create({
        data: {
          employeeId,
          leaveTypeId,
          effectiveDate,
          minutes,
          kind: 'ADJUSTMENT',
          // Null, so the unique index does not apply: an employee may need two
          // corrections on the same type and the same day.
          periodKey: null,
          note: reason,
          createdById: actor.id,
        },
      })

      await writeAudit(
        {
          actorId: actor.id,
          action: 'ledger.adjust',
          entityType: 'LedgerEntry',
          entityId: created.id,
          after: {
            employeeId,
            leaveTypeId,
            effectiveDate: effectiveDate.toISOString().slice(0, 10),
            minutes,
          },
          reason,
        },
        tx,
      )

    })

    revalidatePath('/admin/ledger')
    return { ok: true }
  } catch (error) {
    if (error instanceof ForbiddenError) return fail(error.message)
    console.error(error)
    return fail('Something went wrong. Please try again.')
  }
}
