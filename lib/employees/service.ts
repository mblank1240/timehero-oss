/**
 * Creating an employee, with the transaction and audit trail it needs. The
 * server action in `./actions.ts` authorizes and parses the form; this does
 * the writing, so tests can drive it with an actor id.
 */

import { writeAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import type { SkippedPolicy } from '@/lib/employee-types/plan'
import { assignTypePolicies } from '@/lib/employee-types/service'

import type { EmployeeInput } from './schema'

export type CreatedEmployee = {
  id: string
  /** Policies their employee type put them on, as `PTO: Standard`. */
  assigned: string[]
  skipped: SkippedPolicy[]
}

export type CreateEmployeeResult =
  | { ok: true; value: CreatedEmployee }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> }

/**
 * Creates the employee and, when they are given an employee type, puts them
 * on its policies from their hire date — one transaction, so a failure leaves
 * neither. The employment type used is the one submitted, not the type's
 * default: the form pre-fills it, but the administrator has the last word.
 */
export async function createEmployeeRecord(
  actorId: string | null,
  data: EmployeeInput,
): Promise<CreateEmployeeResult> {
  return db.$transaction(async (tx): Promise<CreateEmployeeResult> => {
    const employeeType = data.employeeTypeId
      ? await tx.employeeType.findUnique({
          where: { id: data.employeeTypeId },
          select: { id: true, name: true, isActive: true },
        })
      : null
    if (data.employeeTypeId && !employeeType?.isActive) {
      return {
        ok: false,
        error: 'Please correct the errors below.',
        fieldErrors: { employeeTypeId: ['Choose an active employee type, or none.'] },
      }
    }

    const employee = await tx.employee.create({ data })

    await writeAudit(
      {
        actorId,
        action: 'employee.create',
        entityType: 'Employee',
        entityId: employee.id,
        after: employee,
      },
      tx,
    )

    const fromType = employeeType
      ? await assignTypePolicies(tx, employee, employeeType, actorId)
      : { assigned: [], skipped: [] }

    return { ok: true, value: { id: employee.id, ...fromType } }
  })
}
