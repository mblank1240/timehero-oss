/**
 * The rows of the one-time import, validated.
 *
 * Two files, because they come from two places: the staff list from whoever
 * keeps personnel records, the balances from whatever tracked leave before.
 * Each row is checked on its own here, with its line number, so a file with
 * five mistakes reports all five at once. Whether the people and policies a
 * row names exist is the service's question (`lib/import/service.ts`).
 *
 * Pure — no database.
 */

import { z } from 'zod'

import { parseDuration } from '@/lib/duration'
import { EMPLOYMENT_TYPES } from '@/lib/employees/schema'

export type RowError = { file: string; line: number; message: string }

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates are YYYY-MM-DD.')
  .transform((s) => new Date(`${s}T00:00:00.000Z`))
  .refine((v) => !Number.isNaN(v.getTime()), 'Not a real date.')

const optionalDate = z.union([z.literal(''), date]).transform((v) => (v === '' ? null : v))

/** "Salaried exempt", "salaried-exempt", "EXEMPT" and "SALARIED_EXEMPT" all mean the same. */
const employmentType = z
  .string()
  .transform((v) => v.trim().toUpperCase().replace(/[\s-]+/g, '_'))
  .transform((v) => (v === 'EXEMPT' || v === 'SALARIED' ? 'SALARIED_EXEMPT' : v))
  .pipe(z.enum(EMPLOYMENT_TYPES))

/**
 * An access role's name, any case, or blank — an ordinary employee, as is
 * `EMPLOYEE`. `ADMIN` and `FINANCE`, from before access roles, still mean the
 * built-in Administrator and the role called Finance.
 */
const role = z
  .string()
  .trim()
  .max(60)
  .transform((v) => (v === '' || v.toUpperCase() === 'EMPLOYEE' ? null : v))

export type PolicyRef = {
  leaveTypeCode: string
  policyName: string
  /** Minutes, from an `=11d`-style override. */
  annualMinutesOverride: number | null
}

export const employeeRow = z
  .object({
    email: z.email('Not an email address.').trim().toLowerCase(),
    first_name: z.string().trim().min(1, 'First name is required.').max(100),
    last_name: z.string().trim().min(1, 'Last name is required.').max(100),
    role: role.default(null),
    /** May be left blank only on a row that names a `type`, which supplies it. */
    employment_type: z.union([z.literal(''), employmentType]).default(''),
    /** An employee type's name, any case. Its policies apply when `policies` is blank. */
    type: z.string().trim().max(100).default(''),
    hire_date: date,
    termination_date: optionalDate.default(null),
    department: z.string().trim().default(''),
    pay_schedule: z.string().trim().default(''),
    /** A duration: `8h`, `450m`, or a bare number of hours. Blank keeps the default. */
    standard_day: z.string().trim().default(''),
    /** `PTO:Standard; SICK:Standard`, with an optional `=16d` allotment override. */
    policies: z.string().trim().default(''),
    /** Approvers' emails in chain order, separated by semicolons. */
    approvers: z.string().trim().default(''),
  })
  .refine((v) => !v.termination_date || v.termination_date >= v.hire_date, {
    path: ['termination_date'],
    message: 'Termination date cannot precede the hire date.',
  })
  .refine((v) => v.employment_type !== '' || v.type !== '', {
    path: ['employment_type'],
    message: 'Required, unless the row names an employee type.',
  })

export type EmployeeRow = {
  line: number
  email: string
  firstName: string
  lastName: string
  /** An access role's name as written; null for none. */
  accessRole: string | null
  /** Null only when `employeeType` is set: the type's employment type applies. */
  employmentType: (typeof EMPLOYMENT_TYPES)[number] | null
  /** An employee type's name, as written. */
  employeeType: string | null
  hireDate: Date
  terminationDate: Date | null
  department: string | null
  paySchedule: string | null
  /** Null leaves the database's default in place. */
  standardMinutesPerDay: number | null
  policies: PolicyRef[]
  approverEmails: string[]
}

/** Only to satisfy `parseDuration`'s signature where days are refused anyway. */
const NO_DAYS = { minutesPerDay: Number.NaN }

const mentionsDays = (text: string) => /\d\s*d/i.test(text)

export function parseEmployeeRows(
  records: readonly Record<string, string>[],
  file = 'employees',
): { rows: EmployeeRow[]; errors: RowError[] } {
  const rows: EmployeeRow[] = []
  const errors: RowError[] = []
  const seen = new Map<string, number>()

  records.forEach((record, index) => {
    // Line 1 is the header.
    const line = index + 2
    const fail = (message: string) => errors.push({ file, line, message })

    const parsed = employeeRow.safeParse(record)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) fail(`${issue.path.join('.') || 'row'}: ${issue.message}`)
      return
    }
    const v = parsed.data

    let day: number | null = null
    if (v.standard_day) {
      day = mentionsDays(v.standard_day) ? null : parseDuration(v.standard_day, NO_DAYS)
      if (day === null || day <= 0 || day > 1440) {
        fail(`standard_day: "${v.standard_day}" is not a working day — try 8h or 450m.`)
        return
      }
    }

    const policies: PolicyRef[] = []
    for (const part of splitList(v.policies)) {
      const match = /^([^:=]+):([^=]+?)(?:=(.+))?$/.exec(part)
      if (!match) {
        fail(`policies: "${part}" should look like PTO:Standard or PTO:Standard=16d.`)
        return
      }
      let override: number | null = null
      if (match[3]) {
        if (day === null && mentionsDays(match[3])) {
          fail(`policies: an allotment in days needs standard_day on the row; or give it in hours.`)
          return
        }
        override = parseDuration(match[3], day === null ? NO_DAYS : { minutesPerDay: day })
        if (override === null || override < 0) {
          fail(`policies: "${match[3]}" is not an allotment.`)
          return
        }
      }
      policies.push({
        leaveTypeCode: match[1].trim().toUpperCase(),
        policyName: match[2].trim(),
        annualMinutesOverride: override,
      })
    }

    const approverEmails = splitList(v.approvers).map((e) => e.toLowerCase())
    if (approverEmails.includes(v.email)) {
      fail('approvers: nobody may approve their own requests.')
      return
    }
    if (new Set(approverEmails).size !== approverEmails.length) {
      fail('approvers: the same person appears twice in the chain.')
      return
    }

    const earlier = seen.get(v.email)
    if (earlier) {
      fail(`email: ${v.email} is already on line ${earlier}.`)
      return
    }
    seen.set(v.email, line)

    rows.push({
      line,
      email: v.email,
      firstName: v.first_name,
      lastName: v.last_name,
      accessRole: v.role,
      employmentType: v.employment_type || null,
      employeeType: v.type || null,
      hireDate: v.hire_date,
      terminationDate: v.termination_date,
      department: v.department || null,
      paySchedule: v.pay_schedule || null,
      standardMinutesPerDay: day,
      policies,
      approverEmails,
    })
  })

  return { rows, errors }
}

export const balanceRow = z.object({
  email: z.email('Not an email address.').trim().toLowerCase(),
  leave_type: z
    .string()
    .trim()
    .min(1, 'Leave type code is required.')
    .transform((v) => v.toUpperCase()),
  /** A duration — `3d`, `22.5h`, `-4h`. Days use the employee's own standard day. */
  balance: z.string().trim().min(1, 'Balance is required.'),
  expires_on: optionalDate.default(null),
})

export type BalanceRow = {
  line: number
  email: string
  leaveTypeCode: string
  balanceText: string
  expiresOn: Date | null
}

export function parseBalanceRows(
  records: readonly Record<string, string>[],
  file = 'balances',
): { rows: BalanceRow[]; errors: RowError[] } {
  const rows: BalanceRow[] = []
  const errors: RowError[] = []
  const seen = new Map<string, number>()

  records.forEach((record, index) => {
    const line = index + 2
    const parsed = balanceRow.safeParse(record)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push({ file, line, message: `${issue.path.join('.') || 'row'}: ${issue.message}` })
      }
      return
    }
    const v = parsed.data
    const key = `${v.email}/${v.leave_type}`
    const earlier = seen.get(key)
    if (earlier) {
      errors.push({ file, line, message: `${v.email} already has a ${v.leave_type} balance on line ${earlier}.` })
      return
    }
    seen.set(key, line)
    rows.push({
      line,
      email: v.email,
      leaveTypeCode: v.leave_type,
      balanceText: v.balance,
      expiresOn: v.expires_on,
    })
  })

  return { rows, errors }
}

function splitList(value: string): string[] {
  return value
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
}
