import 'dotenv/config'

import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

import { applyConfiguration, defaultPolicyIds } from './config/apply'
import { EXAMPLE_CONFIG, loadOrganizationConfig } from './config/organization'

/**
 * Seeds an organization's configuration and a small, obviously-fake staff
 * list for local development. Re-runnable.
 *
 * The configuration comes from the file named by SEED_CONFIG, or
 * `prisma/config/example.json` — a fictional organization — without it. No
 * organization's figures live in this file (rule 1 in CLAUDE.md).
 *
 * With SEED_CONFIGURATION_ONLY=true it seeds the configuration alone — org
 * settings, departments, the pay calendar, holidays, leave types, policies
 * and rollover rules — and no people. That is the one form allowed against
 * production, where real employees then come from `scripts/import.ts`
 * (docs/GO-LIVE.md). It also requires SEED_PAY_ANCHOR_DATE, the start of a
 * real pay period, because every period is generated from it and a guessed
 * one cannot be corrected once timesheets exist, and an explicit SEED_CONFIG,
 * so the example organization never lands in a real database by accident.
 */

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
const db = new PrismaClient({ adapter })

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.test'

const CONFIGURATION_ONLY = process.env.SEED_CONFIGURATION_ONLY === 'true'
const PAY_ANCHOR = process.env.SEED_PAY_ANCHOR_DATE?.trim() || null
const CONFIG_FILE = process.env.SEED_CONFIG?.trim() || null
const config = loadOrganizationConfig(CONFIG_FILE ?? EXAMPLE_CONFIG)

/**
 * The sample data needs somewhere to send email from, so development
 * exercises mail. Only used when the configuration sets none.
 */
const SAMPLE_MAIL_FROM = 'time@example.test'

/** Midnight UTC, `days` before today. */
function daysAgo(days: number) {
  const date = new Date()
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCDate(date.getUTCDate() - days)
  return date
}

async function main() {
  if (process.env.NODE_ENV === 'production' && !CONFIGURATION_ONLY) {
    throw new Error(
      'Refusing to seed sample employees into production. Set SEED_CONFIGURATION_ONLY=true to load the configuration alone.',
    )
  }
  if (CONFIGURATION_ONLY && !PAY_ANCHOR) {
    throw new Error(
      'SEED_CONFIGURATION_ONLY needs SEED_PAY_ANCHOR_DATE=YYYY-MM-DD: the first day of a real pay period.',
    )
  }
  if (CONFIGURATION_ONLY && !CONFIG_FILE) {
    throw new Error(
      "SEED_CONFIGURATION_ONLY needs SEED_CONFIG=<file>: the organization's configuration (see prisma/config/example.json).",
    )
  }
  if (PAY_ANCHOR && !/^\d{4}-\d{2}-\d{2}$/.test(PAY_ANCHOR)) {
    throw new Error('SEED_PAY_ANCHOR_DATE must be YYYY-MM-DD.')
  }

  const mailFromAddress =
    config.organization.mailFromAddress ?? (CONFIGURATION_ONLY ? null : SAMPLE_MAIL_FROM)

  await applyConfiguration(db, config, { payAnchor: PAY_ANCHOR, mailFromAddress })
  const departments = config.departments

  if (CONFIGURATION_ONLY) {
    // Real employees get their policies from the import, row by row.
    console.log('Seeded the configuration only — no employees. Import them with scripts/import.ts.')
    return
  }

  // The sample staff sit in the first two departments, whatever they are called.
  const admin = await db.department.findUniqueOrThrow({ where: { name: departments[0] } })
  const facilities = await db.department.findUniqueOrThrow({
    where: { name: departments[1] ?? departments[0] },
  })

  const people = [
    {
      email: ADMIN_EMAIL,
      firstName: 'Morgan',
      lastName: 'Ellis',
      role: 'ADMIN' as const,
      employmentType: 'SALARIED_EXEMPT' as const,
      hireDate: new Date('2019-03-04'),
      departmentId: admin.id,
    },
    {
      email: 'pastor@example.test',
      firstName: 'Dana',
      lastName: 'Whitfield',
      role: 'ADMIN' as const,
      employmentType: 'SALARIED_EXEMPT' as const,
      hireDate: new Date('2015-07-01'),
      departmentId: admin.id,
    },
    {
      email: 'music@example.test',
      firstName: 'Robin',
      lastName: 'Alvarez',
      role: 'EMPLOYEE' as const,
      employmentType: 'SALARIED_EXEMPT' as const,
      hireDate: new Date('2022-09-12'),
      departmentId: admin.id,
    },
    {
      email: 'custodian@example.test',
      firstName: 'Sam',
      lastName: 'Okafor',
      role: 'EMPLOYEE' as const,
      employmentType: 'HOURLY' as const,
      hireDate: new Date('2024-01-15'),
      departmentId: facilities.id,
    },
    {
      // Exercises the waiting period: hired recently enough that no PTO grant
      // is due yet, whenever the seed runs.
      email: 'newhire@example.test',
      firstName: 'Jess',
      lastName: 'Moreau',
      role: 'EMPLOYEE' as const,
      employmentType: 'HOURLY' as const,
      hireDate: daysAgo(30),
      departmentId: facilities.id,
      standardMinutesPerDay: 240,
    },
    {
      // Reads and exports reports; changes nothing.
      email: 'finance@example.test',
      firstName: 'Lee',
      lastName: 'Chen',
      role: 'FINANCE' as const,
      employmentType: 'SALARIED_EXEMPT' as const,
      hireDate: new Date('2021-04-05'),
      departmentId: admin.id,
    },
    {
      // Exercises the sign-in denial path.
      email: 'former@example.test',
      firstName: 'Pat',
      lastName: 'Reyes',
      role: 'EMPLOYEE' as const,
      employmentType: 'HOURLY' as const,
      hireDate: new Date('2020-02-03'),
      terminationDate: new Date('2026-05-29'),
      isActive: false,
      departmentId: facilities.id,
    },
  ]

  for (const person of people) {
    await db.employee.upsert({
      where: { email: person.email },
      update: {},
      create: person,
    })
  }

  // A two-step chain: Robin reports to Dana, then to Morgan.
  const robin = await db.employee.findUniqueOrThrow({ where: { email: 'music@example.test' } })
  const dana = await db.employee.findUniqueOrThrow({ where: { email: 'pastor@example.test' } })
  const morgan = await db.employee.findUniqueOrThrow({ where: { email: ADMIN_EMAIL } })

  for (const [index, approverId] of [dana.id, morgan.id].entries()) {
    await db.approvalChainStep.upsert({
      where: { employeeId_step: { employeeId: robin.id, step: index + 1 } },
      update: { approverId },
      create: { employeeId: robin.id, step: index + 1, approverId },
    })
  }

  // The pay schedule was created before the people, so give them it now.
  const schedule = await db.paySchedule.findFirstOrThrow({ where: { isDefault: true } })
  await db.employee.updateMany({
    where: { payScheduleId: null },
    data: { payScheduleId: schedule.id },
  })
  await assignDefaultPolicies()

  const count = await db.employee.count()
  console.log(`Seeded org settings, ${departments.length} departments, ${count} employees.`)
  console.log(`Admin sign-in (dev bypass): ${ADMIN_EMAIL}`)
}

/** Puts every employee on the default policy for each leave type. */
async function assignDefaultPolicies() {
  const policyIds = await defaultPolicyIds(db, config)
  const employees = await db.employee.findMany({ select: { id: true, hireDate: true } })

  for (const employee of employees) {
    for (const leavePolicyId of policyIds) {
      const effectiveFrom = employee.hireDate
      await db.employeeLeavePolicy.upsert({
        where: {
          employeeId_leavePolicyId_effectiveFrom: {
            employeeId: employee.id,
            leavePolicyId,
            effectiveFrom,
          },
        },
        update: {},
        create: { employeeId: employee.id, leavePolicyId, effectiveFrom },
      })
    }
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await db.$disconnect()
  })
