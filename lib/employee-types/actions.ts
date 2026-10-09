'use server'

import { revalidatePath } from 'next/cache'

import { ForbiddenError, requireAdminOrThrow } from '@/lib/authz'
import type { ActionResult } from '@/lib/employees/actions'

import { employeeTypeInput } from './schema'
import { writeEmployeeType } from './service'

/**
 * Adds an employee type (`employeeTypeId` null) or saves one. Unticking
 * Active retires it: it leaves the new-employee form, and employees already
 * labelled with it keep the label.
 */
export async function saveEmployeeType(
  employeeTypeId: string | null,
  _previousState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const actor = await requireAdminOrThrow()

    const parsed = employeeTypeInput.safeParse(Object.fromEntries(formData))
    if (!parsed.success) {
      return {
        ok: false,
        error: 'Please correct the errors below.',
        fieldErrors: parsed.error.flatten().fieldErrors,
      }
    }

    const result = await writeEmployeeType(actor.id, employeeTypeId, parsed.data)
    if (!result.ok) return result

    revalidatePath('/admin/employee-types')
    revalidatePath(`/admin/employee-types/${result.value.id}`)
    return { ok: true }
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: error.message }
    if (typeof error === 'object' && error !== null && 'code' in error) {
      if ((error as { code: string }).code === 'P2002') {
        return { ok: false, error: 'An employee type with that name already exists.' }
      }
    }
    console.error(error)
    return { ok: false, error: 'Something went wrong. Please try again.' }
  }
}
