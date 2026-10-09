import { z } from 'zod'

import { PERMISSIONS } from '@/lib/permissions'

/**
 * An access role as the form posts it. Checkboxes post one `permissions`
 * value each, so the action reads them with `formData.getAll` and hands the
 * array in here.
 */
export const accessRoleInput = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(60),
  description: z.string().trim().max(300).default(''),
  permissions: z
    .array(z.enum(PERMISSIONS as [(typeof PERMISSIONS)[number], ...(typeof PERMISSIONS)[number][]]))
    .transform((ps) => [...new Set(ps)]),
})

export type AccessRoleInput = z.infer<typeof accessRoleInput>
