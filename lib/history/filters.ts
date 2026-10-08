import { z } from 'zod'

import { firstParam, idParam, type SearchParams } from '@/lib/requests/filters'

/** `/history?year=2026&type=…` — a benefit year by its label, and a leave type. */
export const historyFiltersSchema = z.object({
  year: z.coerce.number().int().min(1900).max(9999).optional().catch(undefined),
  type: idParam,
})

export type HistoryFilters = z.infer<typeof historyFiltersSchema>

export function parseHistoryFilters(params: SearchParams): HistoryFilters {
  return historyFiltersSchema.parse({
    year: firstParam(params.year),
    type: firstParam(params.type),
  })
}
