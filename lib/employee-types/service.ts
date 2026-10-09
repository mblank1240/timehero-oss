/**
 * Employee types against the database: saving one, and starting a new
 * employee on one's policies. The decisions are in `./plan.ts`; this file
 * loads what they need and writes what they return, with an audit row for
 * every change (rule 9).
 *
 * Callers authorize first — the server actions in `./actions.ts` and
 * `lib/employees/actions.ts`, which see the session; tests call these
 * directly with an actor id.
 */

import type { Prisma, PrismaClient } from '@prisma/client'

import { writeAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import type { EmploymentType } from '@/lib/employees/assignments'

import { checkTypePolicies, planTypeAssignments, type SkippedPolicy, type TypePolicy } from './plan'
import type { EmployeeTypeInput } from './schema'

type Tx = Prisma.TransactionClient
type Client = PrismaClient | Tx

export type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> }

/** How a type is written to the audit log: its fields and its defaults. */
type TypeSnapshot = {
  name: string
  employmentType: EmploymentType
  isActive: boolean
  sortOrder: number
  policies: { leaveTypeId: string; leavePolicyId: string }[]
}

async function snapshot(tx: Tx, id: string): Promise<TypeSnapshot | null> {
  const row = await tx.employeeType.findUnique({
    where: { id },
    select: {
      name: true,
      employmentType: true,
      isActive: true,
      sortOrder: true,
      policies: {
        orderBy: { leaveTypeId: 'asc' },
        select: { leaveTypeId: true, leavePolicyId: true },
      },
    },
  })
  return row
}

/**
 * Creates a type (`id` null) or replaces one's fields and defaults. Employees
 * already created from it are untouched: a type is only ever read when
 * someone new is made from it.
 */
export async function writeEmployeeType(
  actorId: string,
  id: string | null,
  data: EmployeeTypeInput,
): Promise<ServiceResult<{ id: string }>> {
  return db.$transaction(async (tx): Promise<ServiceResult<{ id: string }>> => {
    const before = id ? await snapshot(tx, id) : null
    if (id && !before) return { ok: false, error: 'That employee type no longer exists.' }

    const found = await tx.leavePolicy.findMany({
      where: { id: { in: data.policies.map((p) => p.leavePolicyId) } },
      select: {
        id: true,
        name: true,
        isActive: true,
        leaveTypeId: true,
        leaveType: { select: { name: true, accruableBy: true } },
      },
    })
    const current = new Set(before?.policies.map((p) => p.leavePolicyId) ?? [])
    const fieldErrors = checkTypePolicies(
      data.employmentType,
      data.policies.map((p) => ({
        leaveTypeId: p.leaveTypeId,
        policy: found.find((f) => f.id === p.leavePolicyId) ?? null,
        alreadyChosen: current.has(p.leavePolicyId),
      })),
    )
    if (Object.keys(fieldErrors).length > 0) {
      return { ok: false, error: 'Please correct the errors below.', fieldErrors }
    }

    const { policies, ...fields } = data
    const row = id
      ? await tx.employeeType.update({ where: { id }, data: fields })
      : await tx.employeeType.create({ data: fields })

    // The defaults are replaced wholesale. Nothing refers to these rows, so
    // there is no history to keep beyond the audit log's.
    await tx.employeeTypePolicy.deleteMany({ where: { employeeTypeId: row.id } })
    await tx.employeeTypePolicy.createMany({
      data: policies.map((p) => ({ employeeTypeId: row.id, ...p })),
    })

    await writeAudit(
      {
        actorId,
        action: id ? 'employeeType.update' : 'employeeType.create',
        entityType: 'EmployeeType',
        entityId: row.id,
        before,
        after: await snapshot(tx, row.id),
      },
      tx,
    )

    return { ok: true, value: { id: row.id } }
  })
}

/** A type's default policies, shaped for the planner. */
export async function typePolicies(
  employeeTypeId: string,
  client: Client = db,
): Promise<TypePolicy[]> {
  const rows = await client.employeeTypePolicy.findMany({
    where: { employeeTypeId },
    orderBy: [{ leaveType: { sortOrder: 'asc' } }, { leaveType: { name: 'asc' } }],
    select: {
      leavePolicy: { select: { id: true, name: true, isActive: true } },
      leaveType: { select: { id: true, name: true, isActive: true, accruableBy: true } },
    },
  })
  return rows.map(({ leavePolicy, leaveType }) => ({
    leavePolicyId: leavePolicy.id,
    policyName: leavePolicy.name,
    policyIsActive: leavePolicy.isActive,
    leaveTypeId: leaveType.id,
    leaveTypeName: leaveType.name,
    leaveTypeIsActive: leaveType.isActive,
    accruableBy: leaveType.accruableBy,
  }))
}

/**
 * Puts a just-created employee on their type's policies, from the hire date,
 * inside the caller's transaction. Returns what was assigned and what was
 * skipped and why, for the administrator to see.
 */
export async function assignTypePolicies(
  tx: Tx,
  employee: { id: string; employmentType: EmploymentType; hireDate: Date },
  employeeType: { id: string; name: string },
  actorId: string | null,
): Promise<{ assigned: string[]; skipped: SkippedPolicy[] }> {
  const policies = await typePolicies(employeeType.id, tx)
  const plan = planTypeAssignments({
    policies,
    employmentType: employee.employmentType,
    hireDate: employee.hireDate,
  })

  const assigned: string[] = []
  for (const assignment of plan.assignments) {
    const row = await tx.employeeLeavePolicy.create({
      data: { employeeId: employee.id, ...assignment },
    })
    const policy = policies.find((p) => p.leavePolicyId === assignment.leavePolicyId)!
    assigned.push(`${policy.leaveTypeName}: ${policy.policyName}`)
    await writeAudit(
      {
        actorId,
        action: 'employeeLeavePolicy.assign',
        entityType: 'Employee',
        entityId: employee.id,
        after: row,
        reason: `Default for employee type ${employeeType.name}`,
      },
      tx,
    )
  }

  return { assigned, skipped: plan.skipped }
}
