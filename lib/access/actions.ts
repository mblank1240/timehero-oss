'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { ForbiddenError, requirePermissionOrThrow } from '@/lib/authz'
import type { ActionResult } from '@/lib/employees/actions'

import { accessRoleInput } from './schema'
import { AccessError, deleteAccessRole as deleteRole, saveAccessRole as saveRole } from './service'

function fail(error: string, fieldErrors?: Record<string, string[]>): ActionResult {
  return { ok: false, error, fieldErrors }
}

function handle(error: unknown): ActionResult {
  if (error instanceof ForbiddenError || error instanceof AccessError) return fail(error.message)
  if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002') {
    return fail('An access role with that name already exists.')
  }
  console.error(error)
  return fail('Something went wrong. Please try again.')
}

/** Creates a role (`id` null) or updates one. */
export async function saveAccessRole(
  id: string | null,
  _previousState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let saved = false
  try {
    const actor = await requirePermissionOrThrow('MANAGE_ACCESS')
    const parsed = accessRoleInput.safeParse({
      name: formData.get('name'),
      description: formData.get('description') ?? '',
      permissions: formData.getAll('permissions'),
    })
    if (!parsed.success) {
      return fail('Please correct the errors below.', parsed.error.flatten().fieldErrors)
    }
    await saveRole(actor.id, id, parsed.data)
    revalidatePath('/admin/access')
    saved = true
  } catch (error) {
    return handle(error)
  }
  // Outside the try: `redirect` throws its own control-flow signal.
  if (saved) redirect('/admin/access')
  return { ok: true }
}

export async function deleteAccessRole(id: string): Promise<ActionResult> {
  try {
    const actor = await requirePermissionOrThrow('MANAGE_ACCESS')
    await deleteRole(actor.id, id)
    revalidatePath('/admin/access')
    return { ok: true }
  } catch (error) {
    return handle(error)
  }
}
