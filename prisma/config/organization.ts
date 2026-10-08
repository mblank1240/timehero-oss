import { readFileSync } from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import {
  ACCRUABLE_BY,
  ACCRUAL_METHODS,
  CAP_BASES,
  DISPLAY_UNITS,
  FIRST_YEAR_GRANTS,
  PAY_SCHEDULE_TYPES,
} from '../../lib/config/schema'

/**
 * An organization's starting configuration: org settings, departments, the
 * pay calendar, holidays, leave types, policies, rollover rules and carryover
 * windows. `prisma/seed.ts` loads one of these files; nothing in code holds an
 * organization's figures (rule 1 in CLAUDE.md).
 *
 * `SEED_CONFIG` names the file. Without it the seed uses `example.json`, a
 * fictional organization, which is what development and CI run against.
 * Everything here is a starting point an administrator then edits in the app.
 */

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates are YYYY-MM-DD.')
const month = z.number().int().min(1).max(12)
const day = z.number().int().min(1).max(31)
const minutes = z.number().int().min(0)

export const organizationConfig = z
  .object({
    organization: z.object({
      name: z.string().min(1),
      timezone: z.string().min(1),
      benefitYearStartMonth: month,
      benefitYearStartDay: day,
      minimumRequestIncrementMinutes: minutes.positive(),
      allowSubIncrementWhenBalanceIsLower: z.boolean(),
      timesheetIncrementMinutes: minutes.positive(),
      displayUnit: z.enum(DISPLAY_UNITS),
      compTimeMultiplierBps: z.number().int().positive(),
      overtimeWeeklyThresholdMinutes: minutes,
      /** Null sends no email — push and the in-app list only. */
      mailFromAddress: z.email().nullable(),
    }),
    departments: z.array(z.string().min(1)).min(1),
    paySchedule: z.object({
      name: z.string().min(1),
      type: z.enum(PAY_SCHEDULE_TYPES),
      payDateOffsetDays: z.number().int().min(0),
      /**
       * Development only. Production passes the real anchor in
       * SEED_PAY_ANCHOR_DATE, because every period derives from it.
       */
      developmentAnchorDate: date,
    }),
    holidays: z.array(z.object({ date, name: z.string().min(1), minutes: minutes.default(480) })),
    leaveTypes: z
      .array(
        z.object({
          code: z.string().min(1),
          name: z.string().min(1),
          colorHex: z.string().regex(/^#[0-9a-f]{6}$/i),
          sortOrder: z.number().int(),
          countsTowardRollover: z.boolean(),
          accruableBy: z.enum(ACCRUABLE_BY).default('ALL'),
          /** Approved overtime is banked into this type. At most one; must be EXEMPT_ONLY. */
          bankOvertime: z.boolean().default(false),
        }),
      )
      .min(1),
    policies: z.array(
      z.object({
        leaveType: z.string().min(1),
        name: z.string().min(1),
        method: z.enum(ACCRUAL_METHODS),
        annualMinutes: minutes,
        waitingPeriodDays: z.number().int().min(0),
        firstYearGrant: z.enum(FIRST_YEAR_GRANTS),
      }),
    ),
    rolloverRules: z.array(
      z.object({
        leaveType: z.string().min(1),
        capBasis: z.enum(CAP_BASES),
        capValue: z.number().int().min(0),
      }),
    ),
    carryoverWindows: z.array(
      z.object({
        leaveType: z.string().min(1),
        name: z.string().min(1),
        earnedFromMonth: month,
        earnedFromDay: day,
        earnedToMonth: month,
        earnedToDay: day,
        usableUntilMonth: month,
        usableUntilDay: day,
        usableUntilYearOffset: z.number().int().min(0),
        capBasis: z.enum(CAP_BASES),
      }),
    ),
  })
  .superRefine((config, ctx) => {
    const codes = new Set(config.leaveTypes.map((type) => type.code))
    const lists = ['policies', 'rolloverRules', 'carryoverWindows'] as const
    for (const list of lists) {
      config[list].forEach((row, index) => {
        if (!codes.has(row.leaveType)) {
          ctx.addIssue({
            code: 'custom',
            path: [list, index, 'leaveType'],
            message: `No leave type with code ${row.leaveType}.`,
          })
        }
      })
    }
    const banks = config.leaveTypes.filter((type) => type.bankOvertime)
    if (banks.length > 1) {
      ctx.addIssue({ code: 'custom', path: ['leaveTypes'], message: 'Only one leave type can bank overtime.' })
    }
    if (banks[0] && banks[0].accruableBy !== 'EXEMPT_ONLY') {
      // FLSA: see rule 4 in CLAUDE.md.
      ctx.addIssue({
        code: 'custom',
        path: ['leaveTypes'],
        message: `${banks[0].code} banks overtime, so it must be accruableBy EXEMPT_ONLY.`,
      })
    }
  })

export type OrganizationConfig = z.infer<typeof organizationConfig>

export const EXAMPLE_CONFIG = path.join(__dirname, 'example.json')

/** Reads and validates a configuration file, naming the file in any error. */
export function loadOrganizationConfig(file: string): OrganizationConfig {
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
  const parsed = organizationConfig.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`${file} is not a valid configuration:\n${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}
