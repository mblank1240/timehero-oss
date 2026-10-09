/**
 * Sets up a new installation: the organization's configuration and its first
 * administrator, with no sample data. Everything after this is done in the
 * app — staff are added there or with `scripts/import.ts`.
 *
 *   npm run setup -- --config prisma/config/<org>.json \
 *     --admin-email you@example.org --admin-first-name Ada --admin-last-name Lovelace \
 *     --pay-anchor 2026-01-04
 *
 * Optional: --hire-date (the administrator's, default today) and --mail-from,
 * the address email is sent from, overriding the configuration's. An install
 * signing in by emailed link needs one, or nobody can sign in at all.
 *
 * Anything else left out is asked for when run in a terminal. The pay anchor is the
 * first day of a real pay period: every period is generated from it, and it
 * cannot be corrected once timesheets exist.
 *
 * Refuses to run against a database that already has employees, so it can
 * never be mistaken for a re-seed.
 */
import 'dotenv/config'

import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'

import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { z } from 'zod'

import { applyConfiguration, defaultPolicyIds } from '../prisma/config/apply'
import { loadOrganizationConfig } from '../prisma/config/organization'

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    'admin-email': { type: 'string' },
    'admin-first-name': { type: 'string' },
    'admin-last-name': { type: 'string' },
    'pay-anchor': { type: 'string' },
    'hire-date': { type: 'string' },
    'mail-from': { type: 'string' },
  },
})

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')

const fields = {
  config: { question: 'Configuration file (e.g. prisma/config/example.json)', schema: z.string().min(1) },
  'admin-email': { question: "First administrator's email", schema: z.email() },
  'admin-first-name': { question: 'Their first name', schema: z.string().trim().min(1) },
  'admin-last-name': { question: 'Their last name', schema: z.string().trim().min(1) },
  'pay-anchor': { question: 'First day of a real pay period (YYYY-MM-DD)', schema: date },
} as const

type Field = keyof typeof fields

async function collect(): Promise<Record<Field, string>> {
  const answers = {} as Record<Field, string>
  const prompt = process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout })
    : null
  try {
    for (const [key, { question, schema }] of Object.entries(fields) as [Field, (typeof fields)[Field]][]) {
      let value = values[key] ?? (key === 'config' ? process.env.SEED_CONFIG : undefined)
      for (;;) {
        if (value === undefined) {
          if (!prompt) throw new Error(`Missing --${key}.`)
          value = await prompt.question(`${question}: `)
        }
        const parsed = schema.safeParse(value)
        if (parsed.success) {
          answers[key] = parsed.data
          break
        }
        const message = `--${key}: ${parsed.error.issues[0]?.message ?? 'invalid'}`
        if (!prompt) throw new Error(message)
        console.error(message)
        value = undefined
      }
    }
  } finally {
    prompt?.close()
  }
  return answers
}

async function main() {
  const answers = await collect()
  const hireDate = date.parse(values['hire-date'] ?? new Date().toISOString().slice(0, 10))
  const config = loadOrganizationConfig(answers.config)
  const mailFromAddress = z
    .email('--mail-from: not an email address.')
    .nullable()
    .parse(values['mail-from'] ?? config.organization.mailFromAddress)

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })
  try {
    if ((await db.employee.count()) > 0) {
      throw new Error('This database already has employees, so it is already set up. Nothing was changed.')
    }

    await applyConfiguration(db, config, {
      payAnchor: answers['pay-anchor'],
      mailFromAddress,
    })

    const department = await db.department.findUniqueOrThrow({ where: { name: config.departments[0] } })
    const schedule = await db.paySchedule.findFirstOrThrow({ where: { isDefault: true } })
    const effectiveFrom = new Date(`${hireDate}T00:00:00.000Z`)

    // Created by the migrations; it holds every permission.
    const administrator = await db.accessRole.findFirstOrThrow({ where: { allPermissions: true } })
    const admin = await db.employee.create({
      data: {
        email: answers['admin-email'].toLowerCase(),
        firstName: answers['admin-first-name'],
        lastName: answers['admin-last-name'],
        role: 'ADMIN',
        accessRoleId: administrator.id,
        employmentType: 'SALARIED_EXEMPT',
        hireDate: effectiveFrom,
        departmentId: department.id,
        payScheduleId: schedule.id,
      },
    })
    for (const leavePolicyId of await defaultPolicyIds(db, config)) {
      await db.employeeLeavePolicy.create({
        data: { employeeId: admin.id, leavePolicyId, effectiveFrom },
      })
    }

    console.log(`Set up ${config.organization.name}.`)
    console.log(`First administrator: ${admin.email}.`)
    console.log('They sign in with Microsoft or Google as that address, or by emailed link.')
    if (!mailFromAddress) {
      console.log(
        'No sending address is set, so email — and emailed sign-in links — are off. Pass --mail-from, or set one under Administration → Notifications.',
      )
    }
  } finally {
    await db.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
