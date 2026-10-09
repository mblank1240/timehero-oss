import { z } from 'zod'

import { EMPLOYMENT_TYPES } from '@/lib/employees/schema'

/**
 * Validation for employee types. The form posts one select per leave type,
 * named `policy.<leaveTypeId>`, with a policy id or blank for none; they are
 * folded into a list before the schema sees them, as the settings form does
 * with its weekday checkboxes.
 */

export const POLICY_FIELD_PREFIX = 'policy.'

function collectPolicies(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || 'policies' in raw) return raw
  const policies = Object.entries(raw as Record<string, unknown>)
    .filter(([key, value]) => key.startsWith(POLICY_FIELD_PREFIX) && value !== '')
    .map(([key, value]) => ({ leaveTypeId: key.slice(POLICY_FIELD_PREFIX.length), leavePolicyId: value }))
  return { ...raw, policies }
}

export const employeeTypeInput = z.preprocess(
  collectPolicies,
  z.object({
    name: z.string().trim().min(1, 'Name is required.').max(100),
    employmentType: z.enum(EMPLOYMENT_TYPES),
    sortOrder: z.coerce.number().int().min(0).max(999),
    isActive: z
      .union([z.literal('true'), z.literal('on')])
      .optional()
      .transform((v) => v !== undefined),
    /** At most one per leave type, which the field names already guarantee. */
    policies: z
      .array(z.object({ leaveTypeId: z.cuid(), leavePolicyId: z.cuid() }))
      .refine((list) => new Set(list.map((p) => p.leaveTypeId)).size === list.length, {
        message: 'Choose at most one policy per leave type.',
      }),
  }),
)

export type EmployeeTypeInput = z.infer<typeof employeeTypeInput>
