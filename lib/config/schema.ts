import { z } from 'zod'

/**
 * Validation for the configuration layer: org settings, pay schedules,
 * holidays, leave types, policies, rollover rules and carryover windows.
 *
 * Every church-specific number lives in these records rather than in code,
 * so these schemas are the only place that constrains what a policy may say.
 */

export const PAY_SCHEDULE_TYPES = ['WEEKLY', 'BIWEEKLY', 'SEMI_MONTHLY', 'MONTHLY'] as const
export const ACCRUAL_METHODS = ['ANNUAL_LUMP', 'PER_PAY_PERIOD'] as const
export const FIRST_YEAR_GRANTS = ['FULL_AFTER_WAITING', 'PRORATE', 'NONE'] as const
export const ACCRUABLE_BY = ['ALL', 'HOURLY_ONLY', 'EXEMPT_ONLY'] as const
export const CAP_BASES = ['NONE', 'UNLIMITED', 'FIXED_MINUTES', 'EMPLOYEE_DAYS'] as const
export const DISPLAY_UNITS = ['HOURS', 'DAYS'] as const

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker (YYYY-MM-DD).')
  .transform((s) => new Date(`${s}T00:00:00.000Z`))

const checkbox = z
  .union([z.literal('true'), z.literal('on')])
  .optional()
  .transform((v) => v !== undefined)

const minutes = (label: string, max = 60 * 24 * 366) =>
  z.coerce
    .number()
    .int(`${label} must be a whole number of minutes.`)
    .min(0, `${label} cannot be negative.`)
    .max(max, `${label} is implausibly large.`)

/** A day-of-month is validated against its month, so 31 February is rejected. */
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function isRealMonthDay(month: number, day: number): boolean {
  if (month < 1 || month > 12) return false
  return day >= 1 && day <= DAYS_IN_MONTH[month - 1]
}

// ---------------------------------------------------------------------------
// Org settings
// ---------------------------------------------------------------------------

/** ISO weekdays, Monday first, as `OrgSettings.workWeekDays` stores them. */
export const WEEKDAYS = [
  { iso: 1, label: 'Monday' },
  { iso: 2, label: 'Tuesday' },
  { iso: 3, label: 'Wednesday' },
  { iso: 4, label: 'Thursday' },
  { iso: 5, label: 'Friday' },
  { iso: 6, label: 'Saturday' },
  { iso: 7, label: 'Sunday' },
] as const

/**
 * The settings form posts one checkbox per weekday (`workWeekDay1` …), which
 * `Object.fromEntries` would otherwise flatten past recovery. Folded into the
 * array the column holds before the schema sees it.
 */
function collectWorkWeek(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || 'workWeekDays' in raw) return raw
  const days = WEEKDAYS.map((d) => d.iso).filter((iso) => {
    const value = (raw as Record<string, unknown>)[`workWeekDay${iso}`]
    return value === 'true' || value === 'on'
  })
  return { ...raw, workWeekDays: days }
}

export const orgSettingsInput = z.preprocess(
  collectWorkWeek,
  z
    .object({
      name: z.string().trim().min(1, 'Name is required.').max(200),
      timezone: z.string().trim().min(1, 'Timezone is required.').max(64),

      benefitYearStartMonth: z.coerce.number().int().min(1).max(12),
      benefitYearStartDay: z.coerce.number().int().min(1).max(31),

      minimumRequestIncrementMinutes: minutes('Minimum request increment', 1440).refine(
        (v) => v > 0,
        'The request increment must be at least one minute.',
      ),
      allowSubIncrementWhenBalanceIsLower: checkbox,
      timesheetIncrementMinutes: minutes('Timesheet increment', 1440).refine(
        (v) => v > 0,
        'The timesheet increment must be at least one minute.',
      ),

      displayUnit: z.enum(DISPLAY_UNITS),

      /// Basis points, so comp-time maths stays integral. 10000 = 1.0x.
      compTimeMultiplierBps: z.coerce
        .number()
        .int('Enter the multiplier in basis points (10000 = 1.0x).')
        .min(0)
        .max(100_000),

      overtimeWeeklyThresholdMinutes: minutes('Overtime threshold', 10_080),
      /// Days after a pay period's last day that its timesheets are due.
      timesheetDueDaysAfterPeriodEnd: z.coerce.number().int().min(0).max(60).default(3),
      /// The ISO weekday each workweek starts on, for counting overtime.
      workweekStartDay: z.coerce.number().int().min(1).max(7).default(7),

      /// Blank switches overtime logging off. That it names an exempt-only
      /// type is checked by the action, which can see the type.
      compLeaveTypeId: z
        .string()
        .trim()
        .optional()
        .transform((v) => (v ? v : null)),
      /// Blank means banked comp never expires on its own.
      compExpiresAfterDays: z.preprocess(
        (v) => (v === undefined || v === null || (typeof v === 'string' && v.trim() === '') ? null : v),
        z.union([
          z.null(),
          z.coerce
            .number()
            .int('Enter a whole number of days.')
            .min(1, 'Comp has to last at least a day.')
            .max(3660, 'That is more than ten years.'),
        ]),
      ),

      workWeekDays: z
        .array(z.number().int().min(1).max(7))
        .min(1, 'Choose at least one working day.'),
    })
    .refine((v) => isRealMonthDay(v.benefitYearStartMonth, v.benefitYearStartDay), {
      path: ['benefitYearStartDay'],
      message: 'That day does not exist in the chosen month.',
    })
    .refine(
      // A leave increment finer than the timesheet increment would let someone
      // request time they could never record as worked.
      (v) => v.minimumRequestIncrementMinutes >= v.timesheetIncrementMinutes,
      {
        path: ['minimumRequestIncrementMinutes'],
        message: 'The request increment cannot be finer than the timesheet increment.',
      },
    ),
)

// ---------------------------------------------------------------------------
// Pay schedules and holidays
// ---------------------------------------------------------------------------

export const payScheduleInput = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(100),
  type: z.enum(PAY_SCHEDULE_TYPES),
  anchorDate: dateString,
  payDateOffsetDays: z.coerce
    .number()
    .int('Enter a whole number of days.')
    .min(0, 'The pay date cannot fall before the period ends.')
    .max(60, 'A pay date more than 60 days out is almost certainly a mistake.'),
  isDefault: checkbox,
  isActive: checkbox,
})

export const holidayInput = z.object({
  date: dateString,
  name: z.string().trim().min(1, 'Name is required.').max(100),
  minutes: minutes('Holiday length', 1440),
})

// ---------------------------------------------------------------------------
// Leave types and policies
// ---------------------------------------------------------------------------

export const leaveTypeInput = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(1, 'Code is required.')
    .max(20)
    .regex(/^[A-Z0-9_]+$/, 'Use letters, numbers and underscores only.'),
  name: z.string().trim().min(1, 'Name is required.').max(100),
  isPaid: checkbox,
  requiresApproval: checkbox,
  allowsNegativeBalance: checkbox,
  countsTowardRollover: checkbox,
  accruableBy: z.enum(ACCRUABLE_BY),
  colorHex: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex colour, e.g. #1d4ed8.'),
  sortOrder: z.coerce.number().int().min(0).max(999),
  isActive: checkbox,
})

const optionalMinutes = z
  .union([
    z.literal(''),
    z.coerce
      .number()
      .int()
      .min(0)
      .max(60 * 24 * 366),
  ])
  .optional()
  .transform((v) => (v === '' || v === undefined ? null : v))

export const leavePolicyInput = z
  .object({
    name: z.string().trim().min(1, 'Name is required.').max(100),
    leaveTypeId: z.cuid(),
    method: z.enum(ACCRUAL_METHODS),
    annualMinutes: minutes('Annual allotment'),
    maxBalanceMinutes: optionalMinutes,
    waitingPeriodDays: z.coerce
      .number()
      .int('Enter a whole number of days.')
      .min(0)
      .max(730, 'A waiting period over two years is almost certainly a mistake.'),
    firstYearGrant: z.enum(FIRST_YEAR_GRANTS),
    isActive: checkbox,
  })
  .refine((v) => v.maxBalanceMinutes === null || v.maxBalanceMinutes >= v.annualMinutes, {
    path: ['maxBalanceMinutes'],
    // Otherwise a lump-grant policy would forfeit part of its own grant the
    // instant it landed.
    message: 'The balance ceiling cannot be lower than the annual allotment.',
  })

export const employeePolicyInput = z
  .object({
    employeeId: z.cuid(),
    leavePolicyId: z.cuid(),
    annualMinutesOverride: optionalMinutes,
    effectiveFrom: dateString,
    effectiveTo: z
      .union([z.literal(''), dateString])
      .optional()
      .transform((v) => (v === '' || v === undefined ? null : v)),
  })
  .refine((v) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, {
    path: ['effectiveTo'],
    message: 'The end date cannot precede the start date.',
  })

/**
 * Changing an existing assignment in place: its dates and its override. The
 * employee and the policy stay — a different policy is a new assignment.
 */
export const employeePolicyUpdateInput = z
  .object({
    annualMinutesOverride: optionalMinutes,
    effectiveFrom: dateString,
    effectiveTo: z
      .union([z.literal(''), dateString])
      .optional()
      .transform((v) => (v === '' || v === undefined ? null : v)),
  })
  .refine((v) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, {
    path: ['effectiveTo'],
    message: 'The end date cannot precede the start date.',
  })

// ---------------------------------------------------------------------------
// Rollover
// ---------------------------------------------------------------------------

const capFields = {
  capBasis: z.enum(CAP_BASES),
  capValue: z.coerce
    .number()
    .int('Enter a whole number.')
    .min(0, 'A cap cannot be negative.')
    .max(60 * 24 * 366),
}

/**
 * `capValue` means minutes under FIXED_MINUTES but a day count under
 * EMPLOYEE_DAYS, so the plausible range differs wildly between them. A
 * day count of 2400 is a typo; 2400 minutes is five days.
 */
function refineCap<T extends { capBasis: string; capValue: number }>(
  value: T,
  ctx: z.RefinementCtx,
) {
  if (value.capBasis === 'EMPLOYEE_DAYS' && value.capValue > 366) {
    ctx.addIssue({
      code: 'custom',
      path: ['capValue'],
      message: 'That is a number of days — 366 is the maximum.',
    })
  }
  if (
    (value.capBasis === 'FIXED_MINUTES' || value.capBasis === 'EMPLOYEE_DAYS') &&
    value.capValue <= 0
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['capValue'],
      message: 'Enter a cap above zero, or choose "nothing carries over".',
    })
  }
}

export const rolloverRuleInput = z
  .object({
    leaveTypeId: z.cuid(),
    ...capFields,
    carriedExpiresAfterDays: z
      .union([z.literal(''), z.coerce.number().int().min(1).max(366)])
      .optional()
      .transform((v) => (v === '' || v === undefined ? null : v)),
  })
  .superRefine(refineCap)

export const carryoverWindowInput = z
  .object({
    name: z.string().trim().min(1, 'Name is required.').max(100),
    leaveTypeId: z.cuid(),

    earnedFromMonth: z.coerce.number().int().min(1).max(12),
    earnedFromDay: z.coerce.number().int().min(1).max(31),
    earnedToMonth: z.coerce.number().int().min(1).max(12),
    earnedToDay: z.coerce.number().int().min(1).max(31),

    usableUntilMonth: z.coerce.number().int().min(1).max(12),
    usableUntilDay: z.coerce.number().int().min(1).max(31),
    usableUntilYearOffset: z.coerce.number().int().min(0).max(5),

    ...capFields,
    isActive: checkbox,
  })
  .superRefine((v, ctx) => {
    refineCap(v, ctx)

    const pairs: [number, number, string][] = [
      [v.earnedFromMonth, v.earnedFromDay, 'earnedFromDay'],
      [v.earnedToMonth, v.earnedToDay, 'earnedToDay'],
      [v.usableUntilMonth, v.usableUntilDay, 'usableUntilDay'],
    ]
    for (const [month, day, path] of pairs) {
      if (!isRealMonthDay(month, day)) {
        ctx.addIssue({
          code: 'custom',
          path: [path],
          message: 'That day does not exist in the chosen month.',
        })
      }
    }

    // A window that ran backwards would silently rescue nothing.
    const from = v.earnedFromMonth * 100 + v.earnedFromDay
    const to = v.earnedToMonth * 100 + v.earnedToDay
    if (to < from) {
      ctx.addIssue({
        code: 'custom',
        path: ['earnedToMonth'],
        message: 'The earning window ends before it starts.',
      })
    }

    // Expiry in the same year as the earning window means time would expire
    // before the year it carries into even begins.
    if (v.usableUntilYearOffset === 0) {
      const until = v.usableUntilMonth * 100 + v.usableUntilDay
      if (until <= to) {
        ctx.addIssue({
          code: 'custom',
          path: ['usableUntilYearOffset'],
          message: 'With no year offset, the expiry date must fall after the earning window.',
        })
      }
    }
  })
