import { z } from 'zod'

export const ROLES = ['EMPLOYEE', 'ADMIN', 'FINANCE'] as const

export type Role = (typeof ROLES)[number]

export const ROLE_LABEL: Record<Role, string> = {
  EMPLOYEE: 'Employee',
  ADMIN: 'Administrator',
  FINANCE: 'Finance',
}
export const EMPLOYMENT_TYPES = ['HOURLY', 'SALARIED_EXEMPT'] as const

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker (YYYY-MM-DD).')
  // DATE columns are timezone-free; parsing at UTC midnight keeps them
  // off-by-one free regardless of where the server runs.
  .transform((s) => new Date(`${s}T00:00:00.000Z`))

/**
 * An empty form field means "not set", which the database stores as NULL.
 * `.optional()` matters as much as the empty-string branch: a disabled or
 * omitted input is absent from FormData entirely, not present and blank.
 */
const optionalDate = z
  .union([z.literal(''), dateString])
  .optional()
  .transform((v) => (v === '' || v === undefined ? null : v))

const optionalCuid = z
  .union([z.literal(''), z.cuid()])
  .optional()
  .transform((v) => (v === '' || v === undefined ? null : v))

export const employeeInput = z
  .object({
    email: z.email('Enter a valid email address.').trim().toLowerCase(),
    firstName: z.string().trim().min(1, 'First name is required.').max(100),
    lastName: z.string().trim().min(1, 'Last name is required.').max(100),
    role: z.enum(ROLES),
    employmentType: z.enum(EMPLOYMENT_TYPES),
    hireDate: dateString,
    terminationDate: optionalDate,
    departmentId: optionalCuid,
    /// Without one, nothing accrues per pay period and no timesheet is made.
    payScheduleId: optionalCuid,
    standardMinutesPerDay: z.coerce
      .number()
      .int('Enter a whole number of minutes.')
      .min(1, 'A working day must be at least 1 minute.')
      .max(1440, 'A working day cannot exceed 24 hours.'),
    // An unchecked checkbox is absent from FormData entirely, and
    // `z.coerce.boolean()` would read the string "false" as true. Match the
    // checkbox's value explicitly instead.
    isActive: z
      .union([z.literal('true'), z.literal('on')])
      .optional()
      .transform((v) => v !== undefined),
  })
  .refine((v) => !v.terminationDate || v.terminationDate >= v.hireDate, {
    path: ['terminationDate'],
    message: 'Termination date cannot precede the hire date.',
  })

export type EmployeeInput = z.infer<typeof employeeInput>

export const departmentInput = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(100),
})

/**
 * A chain is an ordered list of approver ids. Steps are derived from array
 * position, so the client never sends step numbers that could arrive with
 * gaps or duplicates.
 */
export const approvalChainInput = z.object({
  employeeId: z.cuid(),
  approverIds: z
    .array(z.cuid())
    .max(10, 'An approval chain cannot exceed 10 steps.')
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'An approver can only appear once in a chain.',
    }),
})
