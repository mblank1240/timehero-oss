import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db } from '@/lib/db'
import { runAccrual } from '@/lib/jobs/accrue'
import { runJob } from '@/lib/jobs/runner'
import { balanceAsOf } from '@/lib/ledger/balance'
import { parseBalanceRows, parseEmployeeRows } from '@/lib/import/rows'
import { runImport } from '@/lib/import/service'

/**
 * The one-time import against real Postgres: employees, chains and opening
 * balances, and — the point of the opening-balance design — that the accrual
 * job run afterwards grants nothing on top.
 *
 * Uses the seeded PTO and Sick "Standard" policies and the seed's January
 * benefit year. Everything it creates is torn down afterwards.
 */

const RUN = `imp-${Date.now().toString(36)}`
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const ASOF = d('2026-11-30')

const leader = `${RUN}-leader@example.test`
const newcomer = `${RUN}-new@example.test`

type Csv = Record<string, string>[]

const employeesCsv: Csv = [
  {
    email: leader,
    first_name: 'Lee',
    last_name: 'Leader',
    role: 'ADMIN',
    employment_type: 'salaried exempt',
    hire_date: '2015-07-01',
    department: `${RUN} Dept`,
    policies: 'PTO:Standard; SICK:Standard',
  },
  {
    email: newcomer,
    first_name: 'Nic',
    last_name: 'Newcomer',
    employment_type: 'HOURLY',
    hire_date: '2026-10-01',
    standard_day: '4h',
    policies: 'PTO:Standard; SICK:Standard',
    approvers: leader,
  },
]

const balancesCsv: Csv = [
  { email: leader, leave_type: 'PTO', balance: '3d' },
  { email: leader, leave_type: 'SICK', balance: '20d' },
  { email: leader, leave_type: 'COMP', balance: '1d', expires_on: '2027-02-28' },
  // A half-day employee: "2d" is eight hours of their days.
  { email: newcomer, leave_type: 'SICK', balance: '2d' },
  { email: newcomer, leave_type: 'PTO', balance: '0' },
]

function input(employees = employeesCsv, balances = balancesCsv) {
  const e = parseEmployeeRows(employees)
  const b = parseBalanceRows(balances)
  expect([...e.errors, ...b.errors]).toEqual([])
  return { employees: e.rows, balances: b.rows }
}

let preexistingEntryIds: string[] = []
let preexistingJobRunIds: string[] = []
let types: Record<'PTO' | 'SICK' | 'COMP', string>

beforeAll(async () => {
  preexistingEntryIds = (await db.ledgerEntry.findMany({ select: { id: true } })).map((r) => r.id)
  preexistingJobRunIds = (await db.jobRun.findMany({ select: { id: true } })).map((r) => r.id)
  const rows = await db.leaveType.findMany({ where: { code: { in: ['PTO', 'SICK', 'COMP'] } } })
  types = Object.fromEntries(rows.map((t) => [t.code, t.id])) as typeof types
})

afterAll(async () => {
  const people = await db.employee.findMany({
    where: { email: { startsWith: RUN } },
    select: { id: true },
  })
  const ids = people.map((p) => p.id)
  await db.ledgerEntry.deleteMany({ where: { id: { notIn: preexistingEntryIds } } })
  await db.jobRun.deleteMany({ where: { id: { notIn: preexistingJobRunIds } } })
  await db.auditLog.deleteMany({ where: { OR: [{ entityId: { in: ids } }, { reason: { contains: RUN } }] } })
  await db.approvalChainStep.deleteMany({ where: { employeeId: { in: ids } } })
  await db.employee.deleteMany({ where: { id: { in: ids } } })
  const dept = await db.department.findMany({ where: { name: `${RUN} Dept` } })
  await db.auditLog.deleteMany({ where: { entityId: { in: dept.map((x) => x.id) } } })
  await db.department.deleteMany({ where: { name: `${RUN} Dept` } })
})

const employeeId = async (email: string) =>
  (await db.employee.findUniqueOrThrow({ where: { email }, select: { id: true } })).id

describe('the import', () => {
  it('writes nothing on a dry run, but reports what it would do', async () => {
    const report = await runImport(input(), { asOf: ASOF, commit: false, source: `${RUN}.csv` })

    expect(report.committed).toBe(false)
    expect(report.errors).toEqual([])
    expect(report.employeesCreated).toEqual([leader, newcomer])
    expect(report.balances).toHaveLength(5)
    expect(await db.employee.count({ where: { email: { startsWith: RUN } } })).toBe(0)
    expect(await db.department.count({ where: { name: `${RUN} Dept` } })).toBe(0)
  })

  it('rolls everything back on any error', async () => {
    const report = await runImport(
      input(employeesCsv, [...balancesCsv, { email: newcomer, leave_type: 'COMP', balance: '1h' }]),
      { asOf: ASOF, commit: true, source: `${RUN}.csv` },
    )

    // Comp time for an hourly employee — rule 4, refused at the import too.
    expect(report.committed).toBe(false)
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0].message).toMatch(/cannot be held/)
    expect(await db.employee.count({ where: { email: { startsWith: RUN } } })).toBe(0)
  })

  it('creates the employees, their policies and chain', async () => {
    const report = await runImport(input(), { asOf: ASOF, commit: true, source: `${RUN}.csv` })
    expect(report.committed).toBe(true)
    expect(report.departmentsCreated).toEqual([`${RUN} Dept`])
    expect(report.chainsSet).toBe(1)

    const nic = await db.employee.findUniqueOrThrow({
      where: { email: newcomer },
      include: { approvalChain: { include: { approver: true } }, leavePolicies: true },
    })
    expect(nic.standardMinutesPerDay).toBe(240)
    expect(nic.payScheduleId).not.toBeNull()
    expect(nic.leavePolicies).toHaveLength(2)
    expect(nic.approvalChain.map((s) => s.approver.email)).toEqual([leader])
  })

  it('lands each balance on exactly the figure supplied', async () => {
    const lee = await employeeId(leader)
    const nic = await employeeId(newcomer)

    expect(await balanceAsOf(lee, types.PTO, ASOF)).toBe(3 * 480)
    expect(await balanceAsOf(lee, types.SICK, ASOF)).toBe(20 * 480)
    expect(await balanceAsOf(lee, types.COMP, ASOF)).toBe(480)
    expect(await balanceAsOf(nic, types.SICK, ASOF)).toBe(2 * 240)
    expect(await balanceAsOf(nic, types.PTO, ASOF)).toBe(0)
  })

  /**
   * The bug this design exists to prevent: without this year's grant on the
   * ledger, the next run would add the whole allotment again.
   */
  it('leaves the accrual job nothing to grant afterwards', async () => {
    const ids = [await employeeId(leader), await employeeId(newcomer)]
    const before = await db.ledgerEntry.count({ where: { employeeId: { in: ids } } })

    for (const date of ['2026-11-30', '2026-12-01']) {
      await runJob({ jobName: 'accrue-pay-period' }, (run) => runAccrual(d(date), run))
    }

    expect(await db.ledgerEntry.count({ where: { employeeId: { in: ids } } })).toBe(before)
  })

  it('is a no-op the second time', async () => {
    const before = await db.ledgerEntry.count()
    const report = await runImport(input(), { asOf: ASOF, commit: true, source: `${RUN}.csv` })

    expect(report.employeesCreated).toEqual([])
    expect(report.employeesExisting).toEqual([leader, newcomer])
    expect(report.balances.every((b) => b.status === 'already-imported')).toBe(true)
    expect(await db.ledgerEntry.count()).toBe(before)
  })

  it('records who and what in the audit log', async () => {
    const lee = await employeeId(leader)
    const actions = await db.auditLog.findMany({
      where: { entityId: lee },
      select: { action: true, actorId: true },
    })
    expect(actions.map((a) => a.action).sort()).toEqual([
      'employee.create',
      'ledger.opening',
      'ledger.opening',
      'ledger.opening',
    ])
    expect(actions.every((a) => a.actorId === null)).toBe(true)
  })
})
