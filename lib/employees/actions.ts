'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { diff, writeAudit } from '@/lib/audit'
import { ForbiddenError, requireAdminOrThrow } from '@/lib/authz'
import { db } from '@/lib/db'

import { approvalChainInput, departmentInput, employeeInput } from './schema'

export type ActionResult =
  | { ok: true }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> }

/**
 * Form actions take `(previousState, formData)` so they can be driven by
 * `useActionState`. That lets the browser submit the form natively before
 * hydration completes, instead of the page depending on JavaScript having
 * already attached a handler.
 */
export type FormAction = (
  previousState: ActionResult | null,
  formData: FormData,
) => Promise<ActionResult>

function fail(error: string, fieldErrors?: Record<string, string[]>): ActionResult {
  return { ok: false, error, fieldErrors }
}

function handle(error: unknown): ActionResult {
  if (error instanceof ForbiddenError) return fail(error.message)
  // The only unique constraint on employees is email, and on departments, name.
  if (typeof error === 'object' && error !== null && 'code' in error) {
    if ((error as { code: string }).code === 'P2002') {
      return fail('A record with that value already exists.')
    }
  }
  console.error(error)
  return fail('Something went wrong. Please try again.')
}

export async function createEmployee(
  _previousState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const result = await createEmployeeInner(formData)
  // `redirect` throws a control-flow signal, so it must run outside the
  // try/catch that would otherwise swallow it.
  if (result.ok) redirect('/admin/employees')
  return result
}

async function createEmployeeInner(formData: FormData): Promise<ActionResult> {
  try {
    const actor = await requireAdminOrThrow()

    const parsed = employeeInput.safeParse(Object.fromEntries(formData))
    if (!parsed.success) {
      return fail('Please correct the errors below.', parsed.error.flatten().fieldErrors)
    }

    const employee = await db.employee.create({ data: parsed.data })

    await writeAudit({
      actorId: actor.id,
      action: 'employee.create',
      entityType: 'Employee',
      entityId: employee.id,
      after: employee,
    })

    revalidatePath('/admin/employees')
    return { ok: true }
  } catch (error) {
    if (isUniqueViolation(error)) {
      return fail('An employee with that email address already exists.')
    }
    return handle(error)
  }
}

export async function updateEmployee(
  employeeId: string,
  _previousState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const result = await updateEmployeeInner(employeeId, formData)
  if (result.ok) redirect('/admin/employees')
  return result
}

async function updateEmployeeInner(
  employeeId: string,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const actor = await requireAdminOrThrow()

    const parsed = employeeInput.safeParse(Object.fromEntries(formData))
    if (!parsed.success) {
      return fail('Please correct the errors below.', parsed.error.flatten().fieldErrors)
    }

    const before = await db.employee.findUnique({ where: { id: employeeId } })
    if (!before) return fail('That employee no longer exists.')

    // An admin removing their own access would lock themselves out mid-session
    // with no way back in, so block it rather than let them discover it.
    if (actor.id === employeeId && parsed.data.role !== 'ADMIN') {
      return fail('You cannot remove your own administrator access.')
    }
    if (actor.id === employeeId && !parsed.data.isActive) {
      return fail('You cannot deactivate your own account.')
    }

    // Saving the record is the review: whatever the directory could not
    // know has now been looked at by an administrator.
    const after = await db.employee.update({
      where: { id: employeeId },
      data: { ...parsed.data, needsReview: false },
    })

    const changed = diff(
      before as unknown as Record<string, unknown>,
      after as unknown as Record<string, unknown>,
    )

    if (Object.keys(changed.after).length > 0) {
      await writeAudit({
        actorId: actor.id,
        action: 'employee.update',
        entityType: 'Employee',
        entityId: employeeId,
        before: changed.before,
        after: changed.after,
      })
    }

    revalidatePath('/admin/employees')
    revalidatePath(`/admin/employees/${employeeId}`)
    return { ok: true }
  } catch (error) {
    if (isUniqueViolation(error)) {
      return fail('An employee with that email address already exists.')
    }
    return handle(error)
  }
}

/**
 * Employees are deactivated, never deleted — their ledger and timesheet
 * history has to survive, and a hard delete would orphan approvals.
 */
export async function deactivateEmployee(employeeId: string): Promise<ActionResult> {
  try {
    const actor = await requireAdminOrThrow()

    if (actor.id === employeeId) {
      return fail('You cannot deactivate your own account.')
    }

    const before = await db.employee.findUnique({ where: { id: employeeId } })
    if (!before) return fail('That employee no longer exists.')

    await db.employee.update({ where: { id: employeeId }, data: { isActive: false } })

    await writeAudit({
      actorId: actor.id,
      action: 'employee.deactivate',
      entityType: 'Employee',
      entityId: employeeId,
      before: { isActive: before.isActive },
      after: { isActive: false },
    })

    revalidatePath('/admin/employees')
    return { ok: true }
  } catch (error) {
    return handle(error)
  }
}

export async function createDepartment(
  _previousState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const actor = await requireAdminOrThrow()

    const parsed = departmentInput.safeParse(Object.fromEntries(formData))
    if (!parsed.success) {
      return fail('Please correct the errors below.', parsed.error.flatten().fieldErrors)
    }

    const department = await db.department.create({ data: parsed.data })

    await writeAudit({
      actorId: actor.id,
      action: 'department.create',
      entityType: 'Department',
      entityId: department.id,
      after: department,
    })

    revalidatePath('/admin/departments')
    revalidatePath('/admin/employees')
    return { ok: true }
  } catch (error) {
    if (isUniqueViolation(error)) {
      return fail('A department with that name already exists.')
    }
    return handle(error)
  }
}

/**
 * Replaces an employee's whole chain. Steps are renumbered from the array
 * order, so they are always contiguous and 1-based.
 */
export async function setApprovalChain(
  employeeId: string,
  approverIds: string[],
): Promise<ActionResult> {
  try {
    const actor = await requireAdminOrThrow()

    const parsed = approvalChainInput.safeParse({ employeeId, approverIds })
    if (!parsed.success) {
      return fail(
        parsed.error.issues[0]?.message ?? 'That approval chain is not valid.',
        parsed.error.flatten().fieldErrors,
      )
    }

    if (parsed.data.approverIds.includes(employeeId)) {
      return fail('An employee cannot approve their own requests.')
    }

    const approvers = await db.employee.findMany({
      where: { id: { in: parsed.data.approverIds }, isActive: true },
      select: { id: true },
    })
    if (approvers.length !== parsed.data.approverIds.length) {
      return fail('Every approver must be an active employee.')
    }

    const before = await db.approvalChainStep.findMany({
      where: { employeeId },
      orderBy: { step: 'asc' },
      select: { step: true, approverId: true },
    })

    await db.$transaction(async (tx) => {
      await tx.approvalChainStep.deleteMany({ where: { employeeId } })
      if (parsed.data.approverIds.length > 0) {
        await tx.approvalChainStep.createMany({
          data: parsed.data.approverIds.map((approverId, i) => ({
            employeeId,
            step: i + 1,
            approverId,
          })),
        })
      }

      await writeAudit(
        {
          actorId: actor.id,
          action: 'approvalChain.set',
          entityType: 'Employee',
          entityId: employeeId,
          before,
          after: parsed.data.approverIds.map((approverId, i) => ({
            step: i + 1,
            approverId,
          })),
        },
        tx,
      )
    })

    revalidatePath(`/admin/employees/${employeeId}`)
    return { ok: true }
  } catch (error) {
    return handle(error)
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: string }).code === 'P2002'
  )
}

/**
 * Removes a linked Microsoft or Google account — for a lost account, or one
 * linked to the wrong person. The next sign-in links again by the usual rules.
 */
export async function unlinkIdentity(identityId: string): Promise<ActionResult> {
  try {
    const actor = await requireAdminOrThrow()
    const before = await db.identity.findUnique({ where: { id: identityId } })
    if (!before) return fail('That sign-in is no longer linked.')

    await db.identity.delete({ where: { id: identityId } })
    await writeAudit({
      actorId: actor.id,
      action: 'identity.unlink',
      entityType: 'Employee',
      entityId: before.employeeId,
      before: { provider: before.provider, subject: before.subject, email: before.email },
    })

    revalidatePath(`/admin/employees/${before.employeeId}`)
    return { ok: true }
  } catch (error) {
    return handle(error)
  }
}
