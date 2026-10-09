/**
 * The one-time import: real employees, then their opening balances.
 *
 * Everything happens in one transaction, and a dry run is the same
 * transaction rolled back at the end. That makes the dry run exact — every
 * unique index, CHECK constraint and trigger has had its say — rather than a
 * second implementation of the checks that could disagree with the real one.
 * Any error at all rolls everything back: a half-imported staff list is worse
 * than none.
 *
 * Re-runnable. An employee whose email already exists is left alone, and an
 * opening balance already imported is refused by its idempotency key, so
 * running the same files twice changes nothing. Correcting a balance after
 * the import is an ordinary adjustment in the app, not a second import.
 *
 * Called from `scripts/import.ts`. See docs/GO-LIVE.md for the file formats.
 */

import type { Prisma } from '@prisma/client'

import { writeAudit } from '@/lib/audit'
import { benefitYearContaining } from '@/lib/accrual/dates'
import { planOpeningBalance } from '@/lib/accrual/opening'
import { db } from '@/lib/db'
import { parseDuration } from '@/lib/duration'
import { describeSkipped, planTypeAssignments } from '@/lib/employee-types/plan'
import { typePolicies } from '@/lib/employee-types/service'
import type { EmploymentType } from '@/lib/employees/assignments'
import { entriesFor, writeEntries } from '@/lib/ledger/entries'
import { accruableBy, subjectsForAccrual } from '@/lib/ledger/policies'

import type { BalanceRow, EmployeeRow, RowError } from './rows'

export type ImportOptions = {
  /** The cutover: balances supplied are balances at the end of this day. */
  asOf: Date
  commit: boolean
  /** Recorded on every audit row, e.g. the file names. */
  source: string
}

export type BalanceOutcome = {
  email: string
  leaveType: string
  openingMinutes: number
  grantMinutes: number
  adjustmentMinutes: number
  status: 'imported' | 'already-imported'
}

export type ImportReport = {
  committed: boolean
  errors: RowError[]
  employeesCreated: string[]
  employeesExisting: string[]
  departmentsCreated: string[]
  chainsSet: number
  balances: BalanceOutcome[]
  /**
   * Employees holding a policy with nothing on the ledger for it — no
   * opening balance, now or before, and no grants. The next accrual run will grant them this year's allotment in
   * full, as for a new hire — right for someone who has used none of it,
   * wrong for everyone else.
   */
  missingBalances: { email: string; leaveType: string }[]
  /** A type's default policies a row's employee could not be put on, and why. */
  policiesSkipped: { email: string; message: string }[]
}

/** Thrown to roll the transaction back; carries the report out. */
class Rollback extends Error {
  constructor(readonly report: ImportReport) {
    super('rollback')
  }
}

export async function runImport(
  input: { employees: EmployeeRow[]; balances: BalanceRow[] },
  opts: ImportOptions,
): Promise<ImportReport> {
  const report: ImportReport = {
    committed: false,
    errors: [],
    employeesCreated: [],
    employeesExisting: [],
    departmentsCreated: [],
    chainsSet: 0,
    balances: [],
    missingBalances: [],
    policiesSkipped: [],
  }

  try {
    await db.$transaction(
      async (tx) => {
        await importEmployees(tx, input.employees, opts, report)
        if (report.errors.length === 0) await importBalances(tx, input.balances, opts, report)
        if (report.errors.length === 0) await findMissingBalances(tx, opts, report)
        if (report.errors.length > 0 || !opts.commit) throw new Rollback(report)
      },
      // ~100 employees, each a handful of round trips. The default five
      // seconds is sized for a request, not a migration.
      { timeout: 300_000, maxWait: 10_000 },
    )
    report.committed = true
    return report
  } catch (error) {
    if (error instanceof Rollback) return error.report
    throw error
  }
}

type Tx = Prisma.TransactionClient

async function importEmployees(
  tx: Tx,
  rows: EmployeeRow[],
  opts: ImportOptions,
  report: ImportReport,
) {
  const fail = (line: number, message: string) =>
    report.errors.push({ file: 'employees', line, message })

  const [schedules, policies, employeeTypes] = await Promise.all([
    tx.paySchedule.findMany({ select: { id: true, name: true, isDefault: true } }),
    tx.leavePolicy.findMany({
      select: {
        id: true,
        name: true,
        isActive: true,
        leaveType: { select: { code: true, name: true, accruableBy: true } },
      },
    }),
    tx.employeeType.findMany({
      select: { id: true, name: true, isActive: true, employmentType: true },
    }),
  ])
  const defaultSchedule = schedules.find((s) => s.isDefault) ?? null
  const departments = new Map(
    (await tx.department.findMany({ select: { id: true, name: true } })).map((d) => [
      d.name.toLowerCase(),
      d.id,
    ]),
  )

  const created = new Map<
    string,
    {
      id: string
      row: EmployeeRow
      employmentType: EmploymentType
      employeeType: string | null
      fromType: string[]
    }
  >()

  const accessRoles = await tx.accessRole.findMany({
    select: { id: true, name: true, allPermissions: true },
  })

  for (const row of rows) {
    const existing = await tx.employee.findUnique({ where: { email: row.email }, select: { id: true } })
    if (existing) {
      report.employeesExisting.push(row.email)
      continue
    }

    let payScheduleId: string | null = defaultSchedule?.id ?? null
    if (row.paySchedule) {
      const named = schedules.find((s) => s.name.toLowerCase() === row.paySchedule!.toLowerCase())
      if (!named) {
        fail(row.line, `pay_schedule: no pay schedule is called "${row.paySchedule}".`)
        continue
      }
      payScheduleId = named.id
    }

    let accessRoleId: string | null = null
    if (row.accessRole) {
      const named =
        row.accessRole.toUpperCase() === 'ADMIN'
          ? accessRoles.find((r) => r.allPermissions)
          : accessRoles.find((r) => r.name.toLowerCase() === row.accessRole!.toLowerCase())
      if (!named) {
        fail(row.line, `role: no access role is called "${row.accessRole}".`)
        continue
      }
      accessRoleId = named.id
    }

    let employeeType: (typeof employeeTypes)[number] | null = null
    if (row.employeeType) {
      employeeType =
        employeeTypes.find((t) => t.name.toLowerCase() === row.employeeType!.toLowerCase()) ?? null
      if (!employeeType) {
        fail(row.line, `type: no employee type is called "${row.employeeType}".`)
        continue
      }
      if (!employeeType.isActive) {
        fail(row.line, `type: ${employeeType.name} is inactive.`)
        continue
      }
    }
    // The row's own employment type wins; the type's fills a blank, which
    // `parseEmployeeRows` allows only on a row naming a type.
    const employmentType = row.employmentType ?? employeeType!.employmentType

    const assignments: { leavePolicyId: string; annualMinutesOverride: number | null }[] = []
    for (const ref of row.policies) {
      const policy = policies.find(
        (p) =>
          p.leaveType.code === ref.leaveTypeCode &&
          p.name.toLowerCase() === ref.policyName.toLowerCase(),
      )
      if (!policy) {
        fail(row.line, `policies: no ${ref.leaveTypeCode} policy is called "${ref.policyName}".`)
        continue
      }
      if (!policy.isActive) {
        fail(row.line, `policies: ${ref.leaveTypeCode}:${policy.name} is inactive.`)
        continue
      }
      // Rule 4: comp time, and anything else restricted, never reaches the
      // wrong employment type — not even through an import.
      if (!accruableBy(policy.leaveType.accruableBy, employmentType)) {
        fail(row.line, `policies: ${policy.leaveType.name} is not available to this employment type.`)
        continue
      }
      assignments.push({ leavePolicyId: policy.id, annualMinutesOverride: ref.annualMinutesOverride })
    }

    // A type's policies apply only to a row that lists none: an explicit
    // `policies` column is the whole of what the row means.
    const fromType: string[] = []
    if (employeeType && row.policies.length === 0) {
      const plan = planTypeAssignments({
        policies: await typePolicies(employeeType.id, tx),
        employmentType,
        hireDate: row.hireDate,
      })
      for (const a of plan.assignments) {
        assignments.push({ leavePolicyId: a.leavePolicyId, annualMinutesOverride: null })
        const policy = policies.find((p) => p.id === a.leavePolicyId)!
        fromType.push(`${policy.leaveType.code}:${policy.name}`)
      }
      for (const skipped of plan.skipped) {
        report.policiesSkipped.push({ email: row.email, message: describeSkipped(skipped) })
      }
    }

    let departmentId: string | null = null
    if (row.department) {
      departmentId = departments.get(row.department.toLowerCase()) ?? null
      if (!departmentId) {
        const department = await tx.department.create({ data: { name: row.department } })
        departmentId = department.id
        departments.set(row.department.toLowerCase(), department.id)
        report.departmentsCreated.push(row.department)
        await writeAudit(
          {
            actorId: null,
            action: 'department.create',
            entityType: 'Department',
            entityId: department.id,
            after: { name: department.name },
            reason: `Imported from ${opts.source}`,
          },
          tx,
        )
      }
    }

    const employee = await tx.employee.create({
      data: {
        email: row.email,
        firstName: row.firstName,
        lastName: row.lastName,
        accessRoleId,
        employmentType,
        employeeTypeId: employeeType?.id ?? null,
        hireDate: row.hireDate,
        terminationDate: row.terminationDate,
        isActive: row.terminationDate === null || row.terminationDate >= opts.asOf,
        departmentId,
        payScheduleId,
        ...(row.standardMinutesPerDay === null
          ? {}
          : { standardMinutesPerDay: row.standardMinutesPerDay }),
        leavePolicies: {
          create: assignments.map((a) => ({ ...a, effectiveFrom: row.hireDate })),
        },
      },
      select: { id: true },
    })
    created.set(row.email, {
      id: employee.id,
      row,
      employmentType,
      employeeType: employeeType?.name ?? null,
      fromType,
    })
    report.employeesCreated.push(row.email)
  }

  // Chains second, so an approver may appear later in the file than the
  // people who report to them.
  for (const { id, row, employmentType, employeeType, fromType } of created.values()) {
    const approverIds: string[] = []
    for (const email of row.approverEmails) {
      const approver = await tx.employee.findUnique({
        where: { email },
        select: { id: true, isActive: true },
      })
      if (!approver) {
        fail(row.line, `approvers: nobody has the address ${email}.`)
      } else if (!approver.isActive) {
        fail(row.line, `approvers: ${email} is not active.`)
      } else {
        approverIds.push(approver.id)
      }
    }
    if (approverIds.length === row.approverEmails.length && approverIds.length > 0) {
      await tx.approvalChainStep.createMany({
        data: approverIds.map((approverId, i) => ({ employeeId: id, step: i + 1, approverId })),
      })
      report.chainsSet += 1
    }

    await writeAudit(
      {
        actorId: null,
        action: 'employee.create',
        entityType: 'Employee',
        entityId: id,
        after: {
          email: row.email,
          firstName: row.firstName,
          lastName: row.lastName,
          accessRole: row.accessRole,
          employmentType,
          employeeType,
          hireDate: iso(row.hireDate),
          terminationDate: row.terminationDate ? iso(row.terminationDate) : null,
          policies: [...row.policies.map((p) => `${p.leaveTypeCode}:${p.policyName}`), ...fromType],
          approvers: row.approverEmails,
        },
        reason: `Imported from ${opts.source}`,
      },
      tx,
    )
  }
}

async function importBalances(
  tx: Tx,
  rows: BalanceRow[],
  opts: ImportOptions,
  report: ImportReport,
) {
  if (rows.length === 0) return
  const fail = (line: number, message: string) =>
    report.errors.push({ file: 'balances', line, message })

  const org = await tx.orgSettings.findUnique({ where: { id: 1 } })
  if (!org) {
    fail(1, 'Org settings have not been configured; seed the configuration first.')
    return
  }
  const benefitYear = benefitYearContaining(opts.asOf, org.benefitYearStartMonth, org.benefitYearStartDay)
  const subjects = new Map(
    (await subjectsForAccrual(opts.asOf, tx)).map((s) => [s.employee.id, s]),
  )
  const leaveTypes = new Map(
    (await tx.leaveType.findMany({ select: { id: true, code: true, name: true, accruableBy: true } })).map(
      (t) => [t.code, t],
    ),
  )
  const note = `Opening balance as of ${iso(opts.asOf)}, imported from ${opts.source}`

  for (const row of rows) {
    const employee = await tx.employee.findUnique({
      where: { email: row.email },
      select: {
        id: true,
        hireDate: true,
        terminationDate: true,
        standardMinutesPerDay: true,
        employmentType: true,
        payScheduleId: true,
      },
    })
    if (!employee) {
      fail(row.line, `email: nobody has the address ${row.email}.`)
      continue
    }
    const leaveType = leaveTypes.get(row.leaveTypeCode)
    if (!leaveType) {
      fail(row.line, `leave_type: no leave type has the code ${row.leaveTypeCode}.`)
      continue
    }
    if (!accruableBy(leaveType.accruableBy, employee.employmentType)) {
      fail(row.line, `${leaveType.name} cannot be held by this employee's employment type.`)
      continue
    }
    const openingMinutes = parseDuration(row.balanceText, {
      minutesPerDay: employee.standardMinutesPerDay,
    })
    if (openingMinutes === null) {
      fail(row.line, `balance: "${row.balanceText}" is not a duration — try 3d, 22.5h or -4h.`)
      continue
    }
    if (row.expiresOn && row.expiresOn < opts.asOf) {
      fail(row.line, 'expires_on: already past at the cutover date.')
      continue
    }

    const subject = subjects.get(employee.id)
    const inForce = subject?.policies.find((p) => p.leaveType.id === leaveType.id) ?? null

    let schedule = null
    let periods: { startDate: Date; endDate: Date }[] = []
    if (inForce?.policy.method === 'PER_PAY_PERIOD' && employee.payScheduleId) {
      const found = await tx.paySchedule.findUnique({
        where: { id: employee.payScheduleId },
        select: { type: true, anchorDate: true, payDateOffsetDays: true },
      })
      schedule = found
      periods = await tx.payPeriod.findMany({
        where: {
          payScheduleId: employee.payScheduleId,
          endDate: { gte: benefitYear.start, lte: opts.asOf },
        },
        select: { startDate: true, endDate: true },
        orderBy: { endDate: 'asc' },
      })
    }

    const plan = planOpeningBalance({
      employee: {
        id: employee.id,
        hireDate: employee.hireDate,
        terminationDate: employee.terminationDate,
        standardMinutesPerDay: employee.standardMinutesPerDay,
        employmentType: employee.employmentType,
      },
      leaveTypeId: leaveType.id,
      policy: inForce?.policy ?? null,
      benefitYear,
      asOf: opts.asOf,
      openingMinutes,
      expiresOn: row.expiresOn,
      schedule,
      periods,
      entries: await entriesFor(employee.id, leaveType.id, tx),
      note,
    })

    if (plan.status === 'already-imported') {
      report.balances.push({
        email: row.email,
        leaveType: leaveType.code,
        openingMinutes,
        grantMinutes: 0,
        adjustmentMinutes: 0,
        status: 'already-imported',
      })
      continue
    }

    await writeEntries([...plan.grants, plan.adjustment], {}, tx)

    const grantMinutes = plan.grants.reduce((sum, g) => sum + g.minutes, 0)
    const adjustmentMinutes = plan.adjustment.minutes

    await writeAudit(
      {
        actorId: null,
        action: 'ledger.opening',
        entityType: 'Employee',
        entityId: employee.id,
        after: {
          leaveType: leaveType.code,
          asOf: iso(opts.asOf),
          openingMinutes,
          grants: plan.grants.map((g) => ({ kind: g.kind, periodKey: g.periodKey, minutes: g.minutes })),
          adjustmentMinutes,
        },
        reason: note,
      },
      tx,
    )

    report.balances.push({
      email: row.email,
      leaveType: leaveType.code,
      openingMinutes,
      grantMinutes,
      adjustmentMinutes,
      status: 'imported',
    })
  }
}

async function findMissingBalances(tx: Tx, opts: ImportOptions, report: ImportReport) {
  const subjects = await subjectsForAccrual(opts.asOf, tx)
  // Anyone with any history on a leave type is already being looked after —
  // an opening balance, or grants the jobs have written.
  const started = await tx.ledgerEntry.groupBy({ by: ['employeeId', 'leaveTypeId'] })
  const has = new Set(started.map((e) => `${e.employeeId}/${e.leaveTypeId}`))
  const ids = subjects.map((s) => s.employee.id)
  const emails = new Map(
    (await tx.employee.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } })).map(
      (e) => [e.id, e.email],
    ),
  )
  const balanced = new Set(report.balances.map((b) => `${b.email}/${b.leaveType}`))

  for (const subject of subjects) {
    const email = emails.get(subject.employee.id) ?? subject.employee.id
    for (const { leaveType } of subject.policies) {
      if (has.has(`${subject.employee.id}/${leaveType.id}`)) continue
      if (balanced.has(`${email}/${leaveType.code}`)) continue
      report.missingBalances.push({ email, leaveType: leaveType.code })
    }
  }
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10)
}
