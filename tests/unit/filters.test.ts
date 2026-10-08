import { describe, expect, it } from 'vitest'

import { parseHistoryFilters } from '@/lib/history/filters'
import { filterHref, parseRequestFilters } from '@/lib/requests/filters'

describe('parseRequestFilters', () => {
  it('reads a status and a leave type', () => {
    expect(parseRequestFilters({ status: 'PENDING', type: 'cmabc123' })).toEqual({
      status: 'PENDING',
      type: 'cmabc123',
    })
  })

  it('drops what does not parse instead of failing the page', () => {
    expect(parseRequestFilters({ status: 'pending', type: "x' OR 1=1" })).toEqual({
      status: undefined,
      type: undefined,
    })
    // Never created, so never a filter.
    expect(parseRequestFilters({ status: 'DRAFT' }).status).toBeUndefined()
  })

  it('takes the first of a repeated parameter', () => {
    expect(parseRequestFilters({ status: ['DENIED', 'APPROVED'] }).status).toBe('DENIED')
  })
})

describe('parseHistoryFilters', () => {
  it('reads a year as a number', () => {
    expect(parseHistoryFilters({ year: '2026' }).year).toBe(2026)
  })

  it('drops a year that is not one', () => {
    expect(parseHistoryFilters({ year: 'last' }).year).toBeUndefined()
    expect(parseHistoryFilters({ year: '' }).year).toBeUndefined()
    expect(parseHistoryFilters({ year: '2026.5' }).year).toBeUndefined()
  })
})

describe('filterHref', () => {
  it('changes one filter and keeps the rest', () => {
    expect(filterHref('/requests', { status: 'PENDING', type: 'pto' }, { status: 'APPROVED' })).toBe(
      '/requests?status=APPROVED&type=pto',
    )
  })

  it('clears a filter set to undefined, and drops the query string when none is left', () => {
    expect(filterHref('/requests', { status: 'PENDING' }, { status: undefined })).toBe('/requests')
  })
})
