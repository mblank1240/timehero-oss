/**
 * Filters on the employee's own lists, read from the query string.
 *
 * The query string is input like any other, so it goes through Zod at the
 * boundary. A value that does not parse is dropped rather than rejected: a
 * stale bookmark or a hand-edited URL should show the unfiltered list, not an
 * error page. Filters only ever narrow a query already scoped to the signed-in
 * employee, so nothing here can widen what anyone sees (rule 8).
 */

import { z } from 'zod'

export type SearchParams = Record<string, string | string[] | undefined>

/** The statuses a request can be listed under. `DRAFT` is never created. */
export const LISTED_STATUSES = ['PENDING', 'APPROVED', 'DENIED', 'CANCELLED'] as const

/** A row id as Prisma generates them — cuids, lowercase alphanumerics. */
export const idParam = z
  .string()
  .regex(/^[a-z0-9]{1,64}$/)
  .optional()
  .catch(undefined)

export const requestFiltersSchema = z.object({
  status: z.enum(LISTED_STATUSES).optional().catch(undefined),
  type: idParam,
})

export type RequestFilters = z.infer<typeof requestFiltersSchema>

/** A repeated parameter (`?status=A&status=B`) counts as its first value. */
export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export function parseRequestFilters(params: SearchParams): RequestFilters {
  return requestFiltersSchema.parse({
    status: firstParam(params.status),
    type: firstParam(params.type),
  })
}

/**
 * A link to the same list with one filter changed and the rest kept. Passing
 * undefined clears that filter.
 */
export function filterHref(
  path: string,
  current: Record<string, string | number | undefined>,
  change: Record<string, string | number | undefined>,
): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries({ ...current, ...change })) {
    if (value !== undefined && value !== '') query.set(key, String(value))
  }
  const text = query.toString()
  return text ? `${path}?${text}` : path
}
