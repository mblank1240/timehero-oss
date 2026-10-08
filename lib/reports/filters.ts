/**
 * Reading a report's filters from the query string. Pure.
 *
 * The page and its export route read the same parameters through this, so
 * the CSV is always exactly what the page is showing. A value that does not
 * parse is ignored in favour of the default, as on every other filtered page.
 */

import { benefitYearContaining } from '@/lib/accrual/dates'

type Params = Record<string, string | string[] | undefined>

export function dateParam(params: Params, name: string): Date | null {
  const value = params[name]
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T00:00:00.000Z`)
  // Round-trip, so 2026-02-30 is refused rather than read as 2 March.
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date
}

export function idParam(params: Params, name: string): string | null {
  const value = params[name]
  return typeof value === 'string' && /^[a-z0-9]{1,64}$/i.test(value) ? value : null
}

export type DateRange = { from: Date; to: Date }

/**
 * `from` and `to`, inclusive. Defaults to the benefit year so far; a range
 * given backwards is turned round rather than shown empty.
 */
export function rangeParams(
  params: Params,
  org: { benefitYearStartMonth: number; benefitYearStartDay: number },
  today: Date,
): DateRange {
  const year = benefitYearContaining(today, org.benefitYearStartMonth, org.benefitYearStartDay)
  const from = dateParam(params, 'from') ?? year.start
  const to = dateParam(params, 'to') ?? today
  return from <= to ? { from, to } : { from: to, to: from }
}

/** Search params for a link or an export, from the filters in force. */
export function query(values: Record<string, Date | string | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined || value === '') continue
    search.set(key, value instanceof Date ? value.toISOString().slice(0, 10) : value)
  }
  const s = search.toString()
  return s ? `?${s}` : ''
}

/** The search params a route handler receives, as a page would. */
export function paramsOf(url: URL): Params {
  return Object.fromEntries(url.searchParams.entries())
}
