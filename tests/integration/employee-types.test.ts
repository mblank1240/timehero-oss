import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db } from '@/lib/db'
import { writeEmployeeType } from '@/lib/employee-types/service'
import { employeeInput } from '@/lib/employees/schema'
import { createEmployeeRecord } from '@/lib/employees/service'
import { parseEmployeeRows } from '@/lib/import/rows'
import { runImport } from '@/lib/import/service'
import { holdersWhere } from '@/lib/permissions'

import { applyConfiguration } from '../../prisma/config/apply'
import { EXAMPLE_CONFIG, loadOrganizationConfig } from '../../prisma/config/organization'

/**
 * Employee types against real Postgres: saving one, creating an employee from
 * it, the import's `type` column, and the configuration file — and, the
 * point of the design, that a type is a pre-fill only, so editing one later
 * never reaches anyone already created from it.
 *
 * Uses the seeded PTO and Sick policies, plus an exempt-only leave type made
 * here to stand in for comp time. Namespaced by a run id and torn down
 * afterwards.
 */

const RUN = `ettest-${Date.now().toString(36)}`
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

let actorId: string
const leave = { pto: '', sick: '', exempt: '' }
const policy = { ptoStandard: '', ptoSenior: '', sick: '', exempt: '' }
let typeId: string

function employeeForm(key: string, overrides: Record<string, string> = {}) {
  return employeeInput.parse({
    email: `${RUN}-${key}@example.test`,
    firstName: RUN,
    lastName: key,
    role: 'EMPLOYEE',
    employmentType: 'SALARIED_EXEMPT',
    hireDate: '2026-03-02',
    standardMinutesPerDay: '480',
    isActive: 'true',
    employeeTypeId: typeId,
    ...overrides,
  })
}

const assignmentsOf = (email: string) =>
  db.employeeLeavePolicy.findMany({
    where: { employee: { email } },
    orderBy: { leavePolicy: { leaveType: { sortOrder: 'asc' } } },
    select: {
      leavePolicyId: true,
      effectiveFrom: true,
      effectiveTo: true,
      annualMinutesOverride: true,
    },
  })

beforeAll(async () => {
  const admin = await db.employee.findFirst({
    where: { ...holdersWhere(['MANAGE_EMPLOYEES']), isActive: true },
  })
  if (!admin) throw new Error('Run `npm run db:seed` before the integration tests.')
  actorId = admin.id

  const policies = await db.leavePolicy.findMany({
    where: { leaveType: { code: { in: ['PTO', 'SICK'] } } },
    include: { leaveType: true },
  })
  const find = (code: string, name: string) => {
    const found = policies.find((p) => p.leaveType.code === code && p.name === name)
    if (!found) throw new Error(`The seed has no ${code} policy called ${name}.`)
    return found
  }
  leave.pto = find('PTO', 'Standard').leaveTypeId
  leave.sick = find('SICK', 'Standard').leaveTypeId
  policy.ptoStandard = find('PTO', 'Standard').id
  policy.ptoSenior = find('PTO', '5+ Years').id
  policy.sick = find('SICK', 'Standard').id

  const exempt = await db.leaveType.create({
    data: {
      code: `${RUN}-X`,
      name: `${RUN} exempt`,
      accruableBy: 'EXEMPT_ONLY',
      sortOrder: 900,
      policies: {
        create: { name: 'Banked', method: 'ANNUAL_LUMP', annualMinutes: 0 },
      },
    },
    include: { policies: true },
  })
  leave.exempt = exempt.id
  policy.exempt = exempt.policies[0].id
})

afterAll(async () => {
  const people = await db.employee.findMany({
    where: { email: { startsWith: RUN } },
    select: { id: true },
  })
  const types = await db.employeeType.findMany({
    where: { name: { startsWith: RUN } },
    select: { id: true },
  })
  const ids = [...people.map((p) => p.id), ...types.map((t) => t.id)]
  await db.auditLog.deleteMany({
    where: { OR: [{ entityId: { in: ids } }, { reason: { contains: RUN } }] },
  })
  await db.employee.deleteMany({ where: { id: { in: people.map((p) => p.id) } } })
  await db.employeeType.deleteMany({ where: { id: { in: types.map((t) => t.id) } } })
  await db.leavePolicy.deleteMany({ where: { leaveTypeId: leave.exempt } })
  await db.leaveType.deleteMany({ where: { id: leave.exempt } })
})

describe('saving an employee type', () => {
  it('creates the type with one default per leave type, and audits it', async () => {
    const result = await writeEmployeeType(actorId, null, {
      name: `${RUN} Director`,
      employmentType: 'SALARIED_EXEMPT',
      sortOrder: 0,
      isActive: true,
      policies: [
        { leaveTypeId: leave.pto, leavePolicyId: policy.ptoSenior },
        { leaveTypeId: leave.sick, leavePolicyId: policy.sick },
        { leaveTypeId: leave.exempt, leavePolicyId: policy.exempt },
      ],
    })
    if (!result.ok) throw new Error(result.error)
    typeId = result.value.id

    const saved = await db.employeeTypePolicy.findMany({ where: { employeeTypeId: typeId } })
    expect(saved).toHaveLength(3)

    const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: typeId } })
    expect(audit).toMatchObject({ action: 'employeeType.create', actorId })
    expect((audit.after as { policies: unknown[] }).policies).toHaveLength(3)
  })

  it('refuses an exempt-only policy on an hourly type (rule 4)', async () => {
    const result = await writeEmployeeType(actorId, null, {
      name: `${RUN} Hourly`,
      employmentType: 'HOURLY',
      sortOrder: 0,
      isActive: true,
      policies: [{ leaveTypeId: leave.exempt, leavePolicyId: policy.exempt }],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.fieldErrors?.[`policy.${leave.exempt}`]?.[0]).toMatch(/cannot be accrued by hourly/)
    expect(await db.employeeType.count({ where: { name: `${RUN} Hourly` } })).toBe(0)
  })

  it('refuses a policy filed under another leave type', async () => {
    const result = await writeEmployeeType(actorId, null, {
      name: `${RUN} Muddled`,
      employmentType: 'HOURLY',
      sortOrder: 0,
      isActive: true,
      policies: [{ leaveTypeId: leave.sick, leavePolicyId: policy.ptoStandard }],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.fieldErrors?.[`policy.${leave.sick}`]).toEqual([
      'That policy belongs to a different leave type.',
    ])
  })
})

describe('creating an employee from a type', () => {
  it("puts them on the type's policies from their hire date", async () => {
    const result = await createEmployeeRecord(actorId, employeeForm('exempt'))
    if (!result.ok) throw new Error(result.error)
    expect(result.value.skipped).toEqual([])
    expect(result.value.assigned).toHaveLength(3)

    const employee = await db.employee.findUniqueOrThrow({ where: { id: result.value.id } })
    expect(employee.employeeTypeId).toBe(typeId)
    expect(await assignmentsOf(employee.email)).toEqual(
      [policy.ptoSenior, policy.sick, policy.exempt].map((leavePolicyId) => ({
        leavePolicyId,
        effectiveFrom: d('2026-03-02'),
        effectiveTo: null,
        annualMinutesOverride: null,
      })),
    )

    const actions = await db.auditLog.findMany({
      where: { entityId: employee.id },
      select: { action: true, actorId: true },
    })
    expect(actions.map((a) => a.action).sort()).toEqual([
      'employee.create',
      'employeeLeavePolicy.assign',
      'employeeLeavePolicy.assign',
      'employeeLeavePolicy.assign',
    ])
    expect(actions.every((a) => a.actorId === actorId)).toBe(true)
  })

  it('skips what the employment type actually chosen cannot hold', async () => {
    const result = await createEmployeeRecord(
      actorId,
      employeeForm('hourly', { employmentType: 'HOURLY' }),
    )
    if (!result.ok) throw new Error(result.error)
    expect(result.value.skipped.map((s) => [s.leavePolicyId, s.reason])).toEqual([
      [policy.exempt, 'not-accruable'],
    ])
    expect((await assignmentsOf(`${RUN}-hourly@example.test`)).map((a) => a.leavePolicyId)).toEqual([
      policy.ptoSenior,
      policy.sick,
    ])
  })

  it('assigns nothing without a type', async () => {
    const result = await createEmployeeRecord(actorId, employeeForm('none', { employeeTypeId: '' }))
    if (!result.ok) throw new Error(result.error)
    expect(await assignmentsOf(`${RUN}-none@example.test`)).toEqual([])
  })

  it('refuses a retired type, and writes nothing', async () => {
    const retired = await db.employeeType.create({
      data: { name: `${RUN} Retired`, employmentType: 'HOURLY', isActive: false },
    })
    const result = await createEmployeeRecord(
      actorId,
      employeeForm('retired', { employeeTypeId: retired.id }),
    )
    expect(result.ok).toBe(false)
    expect(await db.employee.count({ where: { email: `${RUN}-retired@example.test` } })).toBe(0)
  })
})

describe('editing a type later', () => {
  it('changes nobody already created from it', async () => {
    const before = await assignmentsOf(`${RUN}-exempt@example.test`)

    const result = await writeEmployeeType(actorId, typeId, {
      name: `${RUN} Director`,
      employmentType: 'SALARIED_EXEMPT',
      sortOrder: 1,
      isActive: true,
      policies: [{ leaveTypeId: leave.pto, leavePolicyId: policy.ptoStandard }],
    })
    expect(result.ok).toBe(true)

    expect(await assignmentsOf(`${RUN}-exempt@example.test`)).toEqual(before)
    expect(await db.employeeTypePolicy.count({ where: { employeeTypeId: typeId } })).toBe(1)

    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityId: typeId, action: 'employeeType.update' },
    })
    expect((audit.before as { policies: unknown[] }).policies).toHaveLength(3)
    expect((audit.after as { policies: unknown[] }).policies).toEqual([
      { leaveTypeId: leave.pto, leavePolicyId: policy.ptoStandard },
    ])
  })

  it('applies to the next employee created from it', async () => {
    const result = await createEmployeeRecord(actorId, employeeForm('later'))
    if (!result.ok) throw new Error(result.error)
    expect((await assignmentsOf(`${RUN}-later@example.test`)).map((a) => a.leavePolicyId)).toEqual([
      policy.ptoStandard,
    ])
  })
})

describe('the import', () => {
  const opts = { asOf: d('2026-11-30'), commit: true, source: `${RUN}.csv` }
  const row = (key: string, extra: Record<string, string>) => ({
    email: `${RUN}-imp-${key}@example.test`,
    first_name: RUN,
    last_name: key,
    hire_date: '2026-10-01',
    ...extra,
  })

  it("assigns a type's policies to a row with no policies of its own", async () => {
    const parsed = parseEmployeeRows([
      // No employment type: the type's applies.
      row('typed', { type: `${RUN} director`.toUpperCase() }),
      // Explicit policies win over the type's.
      row('explicit', { type: `${RUN} Director`, employment_type: 'HOURLY', policies: 'SICK:Standard' }),
    ])
    expect(parsed.errors).toEqual([])

    const report = await runImport({ employees: parsed.rows, balances: [] }, opts)
    expect(report.errors).toEqual([])
    expect(report.committed).toBe(true)

    const typed = await db.employee.findUniqueOrThrow({
      where: { email: `${RUN}-imp-typed@example.test` },
    })
    expect(typed).toMatchObject({ employmentType: 'SALARIED_EXEMPT', employeeTypeId: typeId })
    expect(await assignmentsOf(typed.email)).toEqual([
      {
        leavePolicyId: policy.ptoStandard,
        effectiveFrom: d('2026-10-01'),
        effectiveTo: null,
        annualMinutesOverride: null,
      },
    ])

    const explicit = await db.employee.findUniqueOrThrow({
      where: { email: `${RUN}-imp-explicit@example.test` },
    })
    expect(explicit).toMatchObject({ employmentType: 'HOURLY', employeeTypeId: typeId })
    expect((await assignmentsOf(explicit.email)).map((a) => a.leavePolicyId)).toEqual([policy.sick])
  })

  it('reports what a type could not give an employee of another employment type', async () => {
    await writeEmployeeType(actorId, typeId, {
      name: `${RUN} Director`,
      employmentType: 'SALARIED_EXEMPT',
      sortOrder: 1,
      isActive: true,
      policies: [
        { leaveTypeId: leave.pto, leavePolicyId: policy.ptoStandard },
        { leaveTypeId: leave.exempt, leavePolicyId: policy.exempt },
      ],
    })
    const parsed = parseEmployeeRows([
      row('hourly', { type: `${RUN} Director`, employment_type: 'hourly' }),
    ])
    const report = await runImport(
      { employees: parsed.rows, balances: [] },
      { ...opts, commit: false },
    )
    expect(report.errors).toEqual([])
    expect(report.policiesSkipped).toEqual([
      {
        email: `${RUN}-imp-hourly@example.test`,
        message: `${RUN} exempt: Banked was not assigned: this employment type cannot accrue it.`,
      },
    ])
  })

  it('refuses a type that does not exist', async () => {
    const parsed = parseEmployeeRows([row('unknown', { type: `${RUN} Nobody` })])
    const report = await runImport({ employees: parsed.rows, balances: [] }, opts)
    expect(report.committed).toBe(false)
    expect(report.errors[0].message).toBe(`type: no employee type is called "${RUN} Nobody".`)
  })
})

describe('the configuration file', () => {
  it('creates a type once, and leaves it as an administrator edited it on a re-run', async () => {
    const example = loadOrganizationConfig(EXAMPLE_CONFIG)
    const config = {
      ...example,
      employeeTypes: [
        ...example.employeeTypes,
        {
          name: `${RUN} Configured`,
          employmentType: 'HOURLY' as const,
          policies: { PTO: 'Standard', SICK: 'Standard' },
        },
      ],
    }
    const options = { payAnchor: null, mailFromAddress: null }

    await applyConfiguration(db, config, options)
    const created = await db.employeeType.findUniqueOrThrow({
      where: { name: `${RUN} Configured` },
      include: { policies: true },
    })
    expect(created.employmentType).toBe('HOURLY')
    expect(created.policies.map((p) => p.leavePolicyId).sort()).toEqual(
      [policy.ptoStandard, policy.sick].sort(),
    )

    // An administrator moves it to exempt and drops the sick default.
    await writeEmployeeType(actorId, created.id, {
      name: created.name,
      employmentType: 'SALARIED_EXEMPT',
      sortOrder: created.sortOrder,
      isActive: true,
      policies: [{ leaveTypeId: leave.pto, leavePolicyId: policy.ptoStandard }],
    })

    await applyConfiguration(db, config, options)
    const after = await db.employeeType.findUniqueOrThrow({
      where: { name: `${RUN} Configured` },
      include: { policies: true },
    })
    expect(after.employmentType).toBe('SALARIED_EXEMPT')
    expect(after.policies.map((p) => p.leavePolicyId)).toEqual([policy.ptoStandard])
    expect(await db.employeeType.count({ where: { name: `${RUN} Configured` } })).toBe(1)
  })
})
