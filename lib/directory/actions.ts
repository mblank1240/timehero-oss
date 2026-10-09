'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { writeAudit } from '@/lib/audit'
import { ForbiddenError, requirePermissionOrThrow } from '@/lib/authz'
import { db } from '@/lib/db'
import type { ActionResult } from '@/lib/employees/actions'
import { runJob } from '@/lib/jobs/runner'

import { googleWorkspaceInput } from './schema'
import { runDirectorySync } from './sync'

function handle(error: unknown): ActionResult {
  if (error instanceof ForbiddenError) return { ok: false, error: error.message }
  console.error(error)
  return {
    ok: false,
    error: error instanceof Error ? error.message : 'Something went wrong.',
  }
}

const provider = z.enum(['MICROSOFT', 'GOOGLE'])

export async function syncDirectoryNow(): Promise<ActionResult> {
  try {
    const actor = await requirePermissionOrThrow('MANAGE_DIRECTORY')
    const today = new Date()
    await runJob(
      {
        jobName: 'sync-directory',
        periodKey: today.toISOString().slice(0, 10),
      },
      () => runDirectorySync(today, { actorId: actor.id }),
    )
    revalidatePath('/admin/directory')
    revalidatePath('/admin/employees')
    return { ok: true }
  } catch (error) {
    revalidatePath('/admin/directory')
    return handle(error)
  }
}

/**
 * Forgets the connection. Linked accounts stay linked — people keep signing
 * in — but nobody new is linked by domain or created, and the sync stops.
 */
export async function disconnectDirectory(which: 'MICROSOFT' | 'GOOGLE'): Promise<ActionResult> {
  try {
    const actor = await requirePermissionOrThrow('MANAGE_DIRECTORY')
    const before = await db.directoryConnection.findUnique({
      where: { provider: provider.parse(which) },
    })
    if (!before) return { ok: false, error: 'That directory is not connected.' }
    await db.directoryConnection.delete({ where: { provider: which } })
    await writeAudit({
      actorId: actor.id,
      action: 'directory.disconnect',
      entityType: 'DirectoryConnection',
      entityId: which,
      before: { tenantId: before.tenantId, domains: before.domains },
    })
    revalidatePath('/admin/directory')
    return { ok: true }
  } catch (error) {
    return handle(error)
  }
}

export async function setDirectoryOptions(
  which: 'MICROSOFT' | 'GOOGLE',
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const actor = await requirePermissionOrThrow('MANAGE_DIRECTORY')
    const options = {
      autoProvision: formData.get('autoProvision') === 'true',
      chainsFromManager: formData.get('chainsFromManager') === 'true',
    }
    await db.directoryConnection.update({
      where: { provider: provider.parse(which) },
      data: options,
    })
    await writeAudit({
      actorId: actor.id,
      action: 'directory.options',
      entityType: 'DirectoryConnection',
      entityId: which,
      after: options,
    })
    revalidatePath('/admin/directory')
    return { ok: true }
  } catch (error) {
    return handle(error)
  }
}

/**
 * Registers the organization's Google Workspace domains. That is all Google
 * sign-in needs: a Google account whose Workspace domain (`hd`) is one of
 * these is linked to the employee with its address. Reading the Workspace
 * directory is planned, not built — docs/AUTH-PLAN.md.
 */
export async function registerGoogleWorkspace(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const actor = await requirePermissionOrThrow('MANAGE_DIRECTORY')
    const parsed = googleWorkspaceInput.safeParse(Object.fromEntries(formData))
    if (!parsed.success) {
      return {
        ok: false,
        error: 'Please correct the errors below.',
        fieldErrors: { domains: [...new Set(parsed.error.issues.map((i) => i.message))] },
      }
    }
    const { domains } = parsed.data
    await db.directoryConnection.upsert({
      where: { provider: 'GOOGLE' },
      // Until the directory API is built there is no customer id to read;
      // the primary domain stands in for it.
      create: {
        provider: 'GOOGLE',
        tenantId: domains[0],
        domains,
        connectedById: actor.id,
        autoProvision: false,
      },
      update: { tenantId: domains[0], domains, connectedById: actor.id },
    })
    await writeAudit({
      actorId: actor.id,
      action: 'directory.connect',
      entityType: 'DirectoryConnection',
      entityId: 'GOOGLE',
      after: { domains },
    })
    revalidatePath('/admin/directory')
    return { ok: true }
  } catch (error) {
    return handle(error)
  }
}
