import type { PrismaClient } from '@prisma/client'

import { generatePeriods } from '../../lib/payperiods/generate'
import type { OrganizationConfig } from './organization'

/**
 * Writes an organization's configuration: org settings, departments, the pay
 * calendar and holidays, leave types, policies, rollover rules, carryover
 * windows and employee types. No people. Shared by `prisma/seed.ts` (with sample staff) and
 * `scripts/setup.ts` (with a first administrator). Re-runnable: rows that
 * already exist are left as an administrator may have edited them, except
 * policies (see below).
 *
 * `payAnchor` is the first day of a real pay period, YYYY-MM-DD; without it
 * the configuration's development anchor is used.
 */
export async function applyConfiguration(
  db: PrismaClient,
  config: OrganizationConfig,
  { payAnchor, mailFromAddress }: { payAnchor: string | null; mailFromAddress: string | null },
) {
  await db.orgSettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, ...config.organization, mailFromAddress },
  })
  // Databases configured before Phase 8 get the address too, unless an
  // administrator has already chosen one.
  if (mailFromAddress) {
    await db.orgSettings.updateMany({
      where: { id: 1, mailFromAddress: null },
      data: { mailFromAddress },
    })
  }

  for (const name of config.departments) {
    await db.department.upsert({ where: { name }, update: {}, create: { name } })
  }

  await applyCalendar(db, config, payAnchor)
  const typeIds = await applyLeaveConfiguration(db, config)
  await applyEmployeeTypes(db, config, typeIds)
  return { typeIds }
}

/**
 * The pay calendar and holidays.
 *
 * Periods are generated here rather than left to the admin UI: a schedule
 * with no periods is a half-configured system, and every later phase assumes
 * they exist.
 */
async function applyCalendar(db: PrismaClient, config: OrganizationConfig, payAnchor: string | null) {
  const { developmentAnchorDate, ...paySchedule } = config.paySchedule
  const schedule = await db.paySchedule.upsert({
    where: { name: paySchedule.name },
    update: {},
    create: {
      ...paySchedule,
      // Production passes the real anchor in SEED_PAY_ANCHOR_DATE — every
      // period derives from it.
      anchorDate: new Date(`${payAnchor ?? developmentAnchorDate}T00:00:00.000Z`),
      isDefault: true,
    },
  })

  await db.employee.updateMany({
    where: { payScheduleId: null },
    data: { payScheduleId: schedule.id },
  })

  const through = new Date()
  through.setUTCMonth(through.getUTCMonth() + 24)

  const periods = generatePeriods(
    {
      type: schedule.type,
      anchorDate: schedule.anchorDate,
      payDateOffsetDays: schedule.payDateOffsetDays,
    },
    { from: schedule.anchorDate, through },
  )

  for (const period of periods) {
    await db.payPeriod.upsert({
      where: {
        payScheduleId_startDate: {
          payScheduleId: schedule.id,
          startDate: period.startDate,
        },
      },
      update: {},
      create: { payScheduleId: schedule.id, ...period },
    })
  }

  for (const holiday of config.holidays) {
    const date = new Date(holiday.date)
    await db.holiday.upsert({
      where: { date },
      update: {},
      create: { ...holiday, date },
    })
  }
}

/**
 * Leave types, policies, rollover rules and carryover windows from the
 * configuration file. Everything here is editable by an admin; none of it is
 * referenced by code.
 */
async function applyLeaveConfiguration(db: PrismaClient, config: OrganizationConfig) {
  const typeIds = new Map<string, string>()

  for (const { bankOvertime, ...leaveType } of config.leaveTypes) {
    const { id } = await db.leaveType.upsert({
      where: { code: leaveType.code },
      update: {},
      create: leaveType,
    })
    typeIds.set(leaveType.code, id)

    // Approved overtime is banked into this type. Only when nothing is set,
    // so a re-seed never undoes an administrator switching overtime logging off.
    if (bankOvertime) {
      await db.orgSettings.updateMany({
        where: { id: 1, compLeaveTypeId: null },
        data: { compLeaveTypeId: id },
      })
    }
  }

  const typeId = (code: string) => typeIds.get(code)!

  for (const { leaveType, ...policy } of config.policies) {
    const data = { ...policy, leaveTypeId: typeId(leaveType) }

    await db.leavePolicy.upsert({
      where: { leaveTypeId_name: { leaveTypeId: data.leaveTypeId, name: data.name } },
      // Unlike departments and leave types, policy rows are re-applied on every seed: a
      // reseed that left a stale allotment behind would quietly disagree with
      // the configuration file that is supposed to describe it. A real
      // database is configured once, so an administrator's later edits are
      // never touched in practice.
      update: data,
      create: data,
    })
  }

  for (const { leaveType, ...rule } of config.rolloverRules) {
    const data = { ...rule, leaveTypeId: typeId(leaveType) }
    await db.rolloverRule.upsert({
      where: { leaveTypeId: data.leaveTypeId },
      update: data,
      create: data,
    })
  }

  for (const { leaveType, ...window } of config.carryoverWindows) {
    const data = { ...window, leaveTypeId: typeId(leaveType) }
    const existing = await db.carryoverWindow.findFirst({
      where: { leaveTypeId: data.leaveTypeId, name: data.name },
    })
    if (!existing) await db.carryoverWindow.create({ data })
  }

  return typeIds

}

/**
 * Employee types, with their default policies. A type is created, defaults
 * and all, only when no type of that name exists: on a re-run an existing one
 * is left exactly as an administrator may have edited it — its employment
 * type and its defaults included — and one renamed in the app is created
 * again under the file's name. Types only pre-fill new employees, so nothing
 * written here ever reaches an existing employee's policies.
 */
async function applyEmployeeTypes(
  db: PrismaClient,
  config: OrganizationConfig,
  typeIds: Map<string, string>,
) {
  for (const [sortOrder, type] of config.employeeTypes.entries()) {
    const existing = await db.employeeType.findUnique({ where: { name: type.name } })
    if (existing) continue

    const policies = []
    for (const [code, name] of Object.entries(type.policies)) {
      const leaveTypeId = typeIds.get(code)!
      const policy = await db.leavePolicy.findUniqueOrThrow({
        where: { leaveTypeId_name: { leaveTypeId, name } },
        select: { id: true },
      })
      policies.push({ leaveTypeId, leavePolicyId: policy.id })
    }

    await db.employeeType.create({
      data: {
        name: type.name,
        employmentType: type.employmentType,
        sortOrder,
        policies: { create: policies },
      },
    })
  }
}

/**
 * The first policy the configuration lists for each leave type — the one a
 * new employee is put on unless an administrator chooses otherwise. A type
 * with no policy (comp time) is earned from approved overtime instead.
 */
export async function defaultPolicyIds(db: PrismaClient, config: OrganizationConfig) {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const policy of config.policies) {
    if (seen.has(policy.leaveType)) continue
    seen.add(policy.leaveType)
    const { id } = await db.leavePolicy.findFirstOrThrow({
      where: { name: policy.name, leaveType: { code: policy.leaveType } },
    })
    ids.push(id)
  }
  return ids
}
