import { describe, expect, it } from 'vitest'

import { buildHeatmap, groupUses, intensity } from '@/lib/history/heatmap'

import { d } from './support/accrual'

const cells = (heatmap: ReturnType<typeof buildHeatmap>) =>
  heatmap.weeks.flat().filter((cell) => cell !== null)

describe('buildHeatmap', () => {
  it('lays a calendar year out in Sunday-first weeks, padding before the first day', () => {
    // 1 January 2026 is a Thursday: Sunday to Wednesday of the first column
    // belong to 2025 and are left empty.
    const heatmap = buildHeatmap({ start: d('2026-01-01'), end: d('2026-12-31') }, new Map())

    expect(heatmap.weeks[0].map((cell) => cell?.iso ?? null)).toEqual([
      null,
      null,
      null,
      null,
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
    ])
    expect(heatmap.weeks).toHaveLength(53)
    expect(cells(heatmap)).toHaveLength(365)
    expect(heatmap.weeks.at(-1)?.[4]?.iso).toBe('2026-12-31')
  })

  it('includes 29 February in a leap year', () => {
    const heatmap = buildHeatmap({ start: d('2028-01-01'), end: d('2028-12-31') }, new Map())
    expect(cells(heatmap)).toHaveLength(366)
    expect(cells(heatmap).some((cell) => cell.iso === '2028-02-29')).toBe(true)
  })

  it('labels each month above the column holding its first day', () => {
    const heatmap = buildHeatmap({ start: d('2026-01-01'), end: d('2026-12-31') }, new Map())

    expect(heatmap.months).toHaveLength(12)
    expect(heatmap.months[0]).toEqual({ week: 0, month: 1 })
    // 1 February 2026 is the Sunday that opens the sixth column.
    expect(heatmap.months[1]).toEqual({ week: 5, month: 2 })
  })

  it('follows a benefit year that does not start in January', () => {
    const heatmap = buildHeatmap({ start: d('2026-07-01'), end: d('2027-06-30') }, new Map())

    expect(heatmap.months.map((m) => m.month)).toEqual([7, 8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6])
    expect(cells(heatmap)[0].iso).toBe('2026-07-01')
    expect(cells(heatmap).at(-1)?.iso).toBe('2027-06-30')
  })

  it('gives a column to the month that starts in it, not a stub of the one before', () => {
    // Monday 30 March: April begins two days later in the same column.
    const heatmap = buildHeatmap({ start: d('2026-03-30'), end: d('2026-04-30') }, new Map())
    expect(heatmap.months[0]).toEqual({ week: 0, month: 4 })
  })

  it('puts each day’s leave on its cell', () => {
    const uses = groupUses([
      { date: d('2026-02-16'), minutes: 480, leaveTypeId: 'pto' },
      { date: d('2026-02-17'), minutes: 240, leaveTypeId: 'sick' },
    ])
    const heatmap = buildHeatmap({ start: d('2026-01-01'), end: d('2026-12-31') }, uses)
    const byIso = new Map(cells(heatmap).map((cell) => [cell.iso, cell]))

    expect(byIso.get('2026-02-16')).toMatchObject({ minutes: 480, uses: [{ leaveTypeId: 'pto' }] })
    expect(byIso.get('2026-02-17')).toMatchObject({ minutes: 240, uses: [{ leaveTypeId: 'sick' }] })
    expect(byIso.get('2026-02-18')).toMatchObject({ minutes: 0, uses: [] })
  })

  it('refuses a range that ends before it starts', () => {
    expect(() => buildHeatmap({ start: d('2026-02-01'), end: d('2026-01-01') }, new Map())).toThrow()
  })
})

describe('groupUses', () => {
  it('adds two half days of one type on one date, and lists the larger type first', () => {
    const uses = groupUses([
      { date: d('2026-05-22'), minutes: 240, leaveTypeId: 'pto' },
      { date: d('2026-05-22'), minutes: 240, leaveTypeId: 'pto' },
      { date: d('2026-05-22'), minutes: 120, leaveTypeId: 'sick' },
    ])

    expect(uses.get('2026-05-22')).toEqual([
      { leaveTypeId: 'pto', minutes: 480 },
      { leaveTypeId: 'sick', minutes: 120 },
    ])
  })
})

describe('intensity', () => {
  it("is the share of the employee's own day, capped at a full day", () => {
    expect(intensity(240, 480)).toBe(0.5)
    expect(intensity(240, 240)).toBe(1)
    expect(intensity(600, 480)).toBe(1)
    expect(intensity(0, 480)).toBe(0)
    expect(intensity(240, 0)).toBe(0)
  })
})
