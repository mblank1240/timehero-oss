'use server'

import { revalidatePath } from 'next/cache'

import { diff, writeAudit } from '@/lib/audit'
import { ForbiddenError, requirePermissionOrThrow } from '@/lib/authz'
import { db } from '@/lib/db'
import type { ActionResult } from '@/lib/employees/actions'
import { accruableBy, overlapsAny } from '@/lib/employees/assignments'
import { syncPayPeriodsFor } from '@/lib/payperiods/sync'

import {
  carryoverWindowInput,
  employeePolicyInput,
  employeePolicyUpdateInput,
  holidayInput,
  leavePolicyInput,
  leaveTypeInput,
  orgSettingsInput,
  payScheduleInput,
  rolloverRuleInput,
} from './schema'

export type { ActionResult }

function fail(error: string, fieldErrors?: Record<string, string[]>): ActionResult {
  return { ok: false, error, fieldErrors }
}

function handle(error: unknown, duplicateMessage?: string): ActionResult {
  if (error instanceof ForbiddenError) return fail(error.message)
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: string }).code
    if (code === 'P2002') {
      return fail(duplicateMessage ?? 'A record with that value already exists.')
    }
    if (code === 'P2003' || code === 'P2014') {
      return fail('Something still refers to this record, so it cannot be changed.')
    }
  }
  console.error(error)
  return fail('Something went wrong. Please try again.')
}

function parseForm<T extends { safeParse: (v: unknown) => ReturnType<T['safeParse']> }>(
  schema: T,
  formData: FormData,
) {
  return schema.safeParse(Object.fromEntries(formData))
}

// ---------------------------------------------------------------------------
// Org settings
// ---------------------------------------------------------------------------

export async function updateOrgSettings(
  _previousState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const actor = await requirePermissionOrThrow('MANAGE_SETTINGS')

    const parsed = parseForm(orgSettingsInput, formData)
    if (!parsed.success) {
      return fail('Please correct the errors below.', parsed.error.flatten().fieldErrors)
    }

    // Rule 4: comp may only be banked into a type hourly staff cannot hold.
    if (parsed.data.compLeaveTypeId) {
      const type = await db.leaveType.findUnique({
        where: { id: parsed.data.compLeaveTypeId },
        select: { isActive: true, accruableBy: true },
      })
      if (!type?.isActive || type.accruableBy !== 'EXEMPT_ONLY') {
        return fail('Please correct the errors below.', {
          compLeaveTypeId: ['Choose an active leave type that only exempt staff can hold.'],
        })
      }
    }

    const before = await db.orgSettings.findUnique({ where: { id: 1 } })
    const after = await db.orgSettings.upsert({
      where: { id: 1 },
      update: parsed.data,
      create: { id: 1, ...parsed.data },
    })

    const changed = before
      ? diff(
          before as unknown as Record<string, unknown>,
          after as unknown as Record<string, unknown>,
        )
      : { before: {}, after: after as unknown as Record<string, unknown> }

    if (Object.keys(changed.after).length > 0) {
      await writeAudit({
        actorId: actor.id,
        action: 'orgSettings.update',
        entityType: 'OrgSettings',
        entityId: '1',
        before: changed.before,
        after: changed.after,
      })
    }

    revalidatePath('/admin/settings')
    return { ok: true }
  } catch (error) {
    return handle(error)
  }
}

// ---------------------------------------------------------------------------
// Pay schedules
// ---------------------------------------------------------------------------

export async function savePaySchedule(
  payScheduleId: string | null,
  _previousState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const actor = await requirePermissionOrThrow('MANAGE_POLICIES')

    const parsed = parseForm(payScheduleInput, formData)
    if (!parsed.success) {
      return fail('Please correct the errors below.', parsed.error.flatten().fieldErrors)
    }
    const data = parsed.data

    const saved = await db.$transaction(async (tx) => {
      // A partial unique index enforces a single default, so the previous
      // holder has to be cleared in the same transaction.
      if (data.isDefault) {
        await tx.paySchedule.updateMany({
          where: { isDefault: true, ...(payScheduleId ? { id: { not: payScheduleId } } : {}) },
          data: { isDefault: false },
        })
      }

      const before = payScheduleId
        ? await tx.paySchedule.findUnique({ where: { id: payScheduleId } })
        : null

      const row = payScheduleId
        ? await tx.paySchedule.update({ where: { id: payScheduleId }, data })
        : await tx.paySchedule.create({ data })

      await writeAudit(
        {
          actorId: actor.id,
          action: payScheduleId ? 'paySchedule.update' : 'paySchedule.create',
          entityType: 'PaySchedule',
          entityId: row.id,
          before,
          after: row,
        },
        tx,
      )

      return row
    })

    const result = await syncPayPeriods(saved.id)

    revalidatePath('/admin/pay-schedules')
    return result
  } catch (error) {
    return handle(error, 'A pay schedule with that name already exists.')
  }
}

/**
 * Brings a schedule's stored periods in line with its settings, 24 months
 * ahead. Locked periods and periods already past are left untouched — history
 * must not move when someone edits a schedule.
 *
 * The work itself lives in `lib/payperiods/sync.ts`, because the weekly
 * `generate-pay-periods` job does exactly the same thing with no actor to
 * authorize.
 */
export async function syncPayPeriods(
  payScheduleId: string,
  _previousState?: ActionResult | null,
  _formData?: FormData,
): Promise<ActionResult> {
  try {
    const actor = await requirePermissionOrThrow('MANAGE_POLICIES')

    const result = await syncPayPeriodsFor(payScheduleId, { actorId: actor.id })
    if (!result) return fail('That pay schedule no longer exists.')

    revalidatePath('/admin/pay-schedules')
    return { ok: true }
  } catch (error) {
    return handle(error)
  }
}

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

export async function createHoliday(
  _previousState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const actor = await requirePermissionOrThrow('MANAGE_POLICIES')

    const parsed = parseForm(holidayInput, formData)
    if (!parsed.success) {
      return fail('Please correct the errors below.', parsed.error.flatten().fieldErrors)
    }

    const holiday = await db.holiday.create({ data: parsed.data })

    await writeAudit({
      actorId: actor.id,
      action: 'holiday.create',
      entityType: 'Holiday',
      entityId: holiday.id,
      after: holiday,
    })

    revalidatePath('/admin/holidays')
    return { ok: true }
  } catch (error) {
    return handle(error, 'A holiday is already recorded on that date.')
  }
}

export async function deleteHoliday(
  holidayId: string,
  _previousState?: ActionResult | null,
  _formData?: FormData,
): Promise<ActionResult> {
  try {
    const actor = await requirePermissionOrThrow('MANAGE_POLICIES')

    const before = await db.holiday.findUnique({ where: { id: holidayId } })
    if (!before) return fail('That holiday no longer exists.')

    await db.holiday.delete({ where: { id: holidayId } })

    await writeAudit({
      actorId: actor.id,
      action: 'holiday.delete',
      entityType: 'Holiday',
      entityId: holidayId,
      before,
    })

    revalidatePath('/admin/holidays')
    return { ok: true }
  } catch (error) {
    return handle(error)
  }
}

// ---------------------------------------------------------------------------
// Leave types
// ---------------------------------------------------------------------------

export async function saveLeaveType(
  leaveTypeId: string | null,
  _previousState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const actor = await requirePermissionOrThrow('MANAGE_POLICIES')

    const parsed = parseForm(leaveTypeInput, formData)
    if (!parsed.success) {
      return fail('Please correct the errors below.', parsed.error.flatten().fieldErrors)
    }

    const before = leaveTypeId
      ? await db.leaveType.findUnique({ where: { id: leaveTypeId } })
      : null

    const row = leaveTypeId
      ? await db.leaveType.update({ where: { id: leaveTypeId }, data: parsed.data })
      : await db.leaveType.create({ data: parsed.data })

    await writeAudit({
      actorId: actor.id,
      action: leaveTypeId ? 'leaveType.update' : 'leaveType.create',
      entityType: 'LeaveType',
      entityId: row.id,
      before,
      after: row,
    })

    revalidatePath('/admin/leave-types')
    return { ok: true }
  } catch (error) {
    return handle(error, 'A leave type with that code already exists.')
  }
}

// ---------------------------------------------------------------------------
// Leave policies
// ---------------------------------------------------------------------------

export async function saveLeavePolicy(
  leavePolicyId: string | null,
  _previousState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const actor = await requirePermissionOrThrow('MANAGE_POLICIES')

    const parsed = parseForm(leavePolicyInput, formData)
    if (!parsed.success) {
      return fail('Please correct the errors below.', parsed.error.flatten().fieldErrors)
    }

    const before = leavePolicyId
      ? await db.leavePolicy.findUnique({ where: { id: leavePolicyId } })
      : null

    const row = leavePolicyId
      ? await db.leavePolicy.update({ where: { id: leavePolicyId }, data: parsed.data })
      : await db.leavePolicy.create({ data: parsed.data })

    await writeAudit({
      actorId: actor.id,
      action: leavePolicyId ? 'leavePolicy.update' : 'leavePolicy.create',
      entityType: 'LeavePolicy',
      entityId: row.id,
      before,
      after: row,
    })

    revalidatePath('/admin/leave-policies')
    return { ok: true }
  } catch (error) {
    return handle(error, 'That leave type already has a policy with that name.')
  }
}

/**
 * Assigns an employee to a policy. An employee may hold only one active
 * policy per leave type at a time, which the database cannot express, so it
 * is enforced here: an overlapping assignment for the same type is rejected.
 */
export async function assignLeavePolicy(
  _previousState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const actor = await requirePermissionOrThrow('MANAGE_EMPLOYEES')

    const parsed = parseForm(employeePolicyInput, formData)
    if (!parsed.success) {
      return fail('Please correct the errors below.', parsed.error.flatten().fieldErrors)
    }
    const data = parsed.data

    const policy = await db.leavePolicy.findUnique({
      where: { id: data.leavePolicyId },
      select: { leaveTypeId: true, leaveType: { select: { name: true, accruableBy: true } } },
    })
    if (!policy) return fail('That policy no longer exists.')

    const employee = await db.employee.findUnique({
      where: { id: data.employeeId },
      select: { employmentType: true },
    })
    if (!employee) return fail('That employee no longer exists.')

    // Comp time is exempt-only; see rule 4 in CLAUDE.md.
    if (!accruableBy(policy.leaveType.accruableBy, employee.employmentType)) {
      return fail(
        `${policy.leaveType.name} cannot be accrued by this employee's employment type.`,
      )
    }

    const siblings = await db.employeeLeavePolicy.findMany({
      where: {
        employeeId: data.employeeId,
        leavePolicy: { leaveTypeId: policy.leaveTypeId },
      },
      select: { id: true, effectiveFrom: true, effectiveTo: true },
    })

    if (overlapsAny(data, siblings)) {
      return fail(
        'This employee already has a policy for that leave type covering those dates. End the existing assignment first.',
      )
    }

    const row = await db.employeeLeavePolicy.create({ data })

    await writeAudit({
      actorId: actor.id,
      action: 'employeeLeavePolicy.assign',
      entityType: 'Employee',
      entityId: data.employeeId,
      after: row,
    })

    revalidatePath(`/admin/employees/${data.employeeId}`)
    return { ok: true }
  } catch (error) {
    return handle(error, 'That assignment already exists.')
  }
}

/**
 * Changes an assignment's dates or allotment override in place — ending a
 * policy when someone moves tier, or correcting an override — without
 * deleting and recreating it. The same overlap rule as assigning applies.
 *
 * Grants already written stay as they are: an override changed mid-year
 * affects grants not yet made. A correction to this year's grant is a ledger
 * adjustment.
 */
export async function updateLeavePolicyAssignment(
  assignmentId: string,
  _previousState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const actor = await requirePermissionOrThrow('MANAGE_EMPLOYEES')

    const parsed = parseForm(employeePolicyUpdateInput, formData)
    if (!parsed.success) {
      return fail('Please correct the errors below.', parsed.error.flatten().fieldErrors)
    }
    const data = parsed.data

    const before = await db.employeeLeavePolicy.findUnique({
      where: { id: assignmentId },
      include: { leavePolicy: { select: { leaveTypeId: true } } },
    })
    if (!before) return fail('That assignment no longer exists.')

    const siblings = await db.employeeLeavePolicy.findMany({
      where: {
        employeeId: before.employeeId,
        leavePolicy: { leaveTypeId: before.leavePolicy.leaveTypeId },
        id: { not: assignmentId },
      },
      select: { effectiveFrom: true, effectiveTo: true },
    })
    if (overlapsAny(data, siblings)) {
      return fail(
        'Those dates overlap another assignment for the same leave type. Change that one first.',
      )
    }

    const after = await db.employeeLeavePolicy.update({ where: { id: assignmentId }, data })

    const { leavePolicy: _ignored, ...beforeRow } = before
    await writeAudit({
      actorId: actor.id,
      action: 'employeeLeavePolicy.update',
      entityType: 'Employee',
      entityId: before.employeeId,
      before: beforeRow,
      after,
    })

    revalidatePath(`/admin/employees/${before.employeeId}`)
    return { ok: true }
  } catch (error) {
    return handle(error, 'An assignment of that policy already starts on that date.')
  }
}

export async function removeLeavePolicyAssignment(
  assignmentId: string,
): Promise<ActionResult> {
  try {
    const actor = await requirePermissionOrThrow('MANAGE_EMPLOYEES')

    const before = await db.employeeLeavePolicy.findUnique({ where: { id: assignmentId } })
    if (!before) return fail('That assignment no longer exists.')

    await db.employeeLeavePolicy.delete({ where: { id: assignmentId } })

    await writeAudit({
      actorId: actor.id,
      action: 'employeeLeavePolicy.remove',
      entityType: 'Employee',
      entityId: before.employeeId,
      before,
    })

    revalidatePath(`/admin/employees/${before.employeeId}`)
    return { ok: true }
  } catch (error) {
    return handle(error)
  }
}

// ---------------------------------------------------------------------------
// Rollover rules and carryover windows
// ---------------------------------------------------------------------------

export async function saveRolloverRule(
  _previousState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const actor = await requirePermissionOrThrow('MANAGE_POLICIES')

    const parsed = parseForm(rolloverRuleInput, formData)
    if (!parsed.success) {
      return fail('Please correct the errors below.', parsed.error.flatten().fieldErrors)
    }
    const { leaveTypeId, ...rest } = parsed.data

    const before = await db.rolloverRule.findUnique({ where: { leaveTypeId } })
    const row = await db.rolloverRule.upsert({
      where: { leaveTypeId },
      update: rest,
      create: { leaveTypeId, ...rest },
    })

    await writeAudit({
      actorId: actor.id,
      action: 'rolloverRule.save',
      entityType: 'LeaveType',
      entityId: leaveTypeId,
      before,
      after: row,
    })

    revalidatePath('/admin/rollover')
    return { ok: true }
  } catch (error) {
    return handle(error)
  }
}

export async function saveCarryoverWindow(
  windowId: string | null,
  _previousState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const actor = await requirePermissionOrThrow('MANAGE_POLICIES')

    const parsed = parseForm(carryoverWindowInput, formData)
    if (!parsed.success) {
      return fail('Please correct the errors below.', parsed.error.flatten().fieldErrors)
    }

    const before = windowId
      ? await db.carryoverWindow.findUnique({ where: { id: windowId } })
      : null

    const row = windowId
      ? await db.carryoverWindow.update({ where: { id: windowId }, data: parsed.data })
      : await db.carryoverWindow.create({ data: parsed.data })

    await writeAudit({
      actorId: actor.id,
      action: windowId ? 'carryoverWindow.update' : 'carryoverWindow.create',
      entityType: 'CarryoverWindow',
      entityId: row.id,
      before,
      after: row,
    })

    revalidatePath('/admin/rollover')
    return { ok: true }
  } catch (error) {
    return handle(error)
  }
}

export async function deleteCarryoverWindow(
  windowId: string,
  _previousState?: ActionResult | null,
  _formData?: FormData,
): Promise<ActionResult> {
  try {
    const actor = await requirePermissionOrThrow('MANAGE_POLICIES')

    const before = await db.carryoverWindow.findUnique({ where: { id: windowId } })
    if (!before) return fail('That window no longer exists.')

    await db.carryoverWindow.delete({ where: { id: windowId } })

    await writeAudit({
      actorId: actor.id,
      action: 'carryoverWindow.delete',
      entityType: 'CarryoverWindow',
      entityId: windowId,
      before,
    })

    revalidatePath('/admin/rollover')
    return { ok: true }
  } catch (error) {
    return handle(error)
  }
}

