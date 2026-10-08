import { describe, expect, it } from 'vitest'

import { toCsv, csvField } from '@/lib/csv'
import { buildGrid, holidayMinutesFor, liveLines, periodDates, type GridInput } from '@/lib/timesheets/grid'
import { periodCsvRows } from '@/lib/timesheets/report'
import { timesheetGridInput } from '@/lib/timesheets/schema'

import { d, iso } from './support/accrual'

// A biweekly period from Wednesday 7 to Tuesday 20 October 2026, so its first
// Sunday-start workweek began on the previous period's timesheet.
const PERIOD = { startDate: d('2026-10-07'), endDate: d('2026-10-20') }
const EMPLOYEE = { hireDate: d('2024-01-15'), terminationDate: null, standardMinutesPerDay: 480 }
const RULES = { thresholdMinutes: 2400, weekStartDay: 7 }

function input(overrides: Partial<GridInput> = {}): GridInput {
  return {
    period: PERIOD,
    employee: EMPLOYEE,
    worked: [],
    workedBefore: [],
    leave: [],
    holidays: [],
    rules: RULES,
    ...overrides,
  }
}

const worked = (date: string, minutes: number, note: string | null = null) => ({
  date: d(date),
  minutes,
  note,
})

describe('periodDates', () => {
  it('lists every day of the period, both ends included', () => {
    const dates = periodDates(PERIOD).map(iso)
    expect(dates).toHaveLength(14)
    expect(dates[0]).toBe('2026-10-07')
    expect(dates.at(-1)).toBe('2026-10-20')
  })
})

describe('buildGrid', () => {
  it('counts the previous timesheet’s days toward the first week’s overtime', () => {
    // Mon 5 and Tue 6 Oct are on last period's timesheet: 20 hours already.
    const grid = buildGrid(
      input({
        workedBefore: [
          { date: d('2026-10-05'), minutes: 600 },
          { date: d('2026-10-06'), minutes: 600 },
          // Before the workweek began: no part of this period's weeks.
          { date: d('2026-10-03'), minutes: 900 },
        ],
        worked: [
          worked('2026-10-07', 600),
          worked('2026-10-08', 600),
          worked('2026-10-09', 600),
          worked('2026-10-12', 480),
        ],
      }),
    )
    expect(grid.days.find((x) => x.iso === '2026-10-08')?.overtime).toBe(0)
    expect(grid.days.find((x) => x.iso === '2026-10-09')?.overtime).toBe(600)
    expect(grid.days.find((x) => x.iso === '2026-10-12')?.overtime).toBe(0)
    expect(grid.totals).toMatchObject({ worked: 2280, overtime: 600, regular: 1680 })
    expect(grid.weeks[0]).toMatchObject({ worked: 1800, weekWorked: 3000, overtime: 600 })
  })

  it('does not count leave or holidays toward overtime', () => {
    const grid = buildGrid(
      input({
        worked: ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'].map((x) => worked(x, 600)),
        holidays: [{ date: d('2026-10-16'), minutes: 480, name: 'Founders Day' }],
        leave: [
          {
            date: d('2026-10-17'),
            minutes: 480,
            leaveRequestId: 'r1',
            leaveTypeId: 'pto',
            leaveTypeName: 'PTO',
          },
        ],
      }),
    )
    expect(grid.totals).toMatchObject({ worked: 2400, overtime: 0, holiday: 480, leave: 480 })
    expect(grid.totals.leaveByType).toEqual([
      { leaveTypeId: 'pto', leaveTypeName: 'PTO', minutes: 480 },
    ])
  })

  it('marks days outside employment', () => {
    const grid = buildGrid(input({ employee: { ...EMPLOYEE, hireDate: d('2026-10-12') } }))
    expect(grid.days.filter((x) => !x.employed).map((x) => x.iso)).toEqual([
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
    ])
  })
})

describe('liveLines', () => {
  it('pays a holiday at the employee’s own day, never more than the calendar says', () => {
    expect(holidayMinutesFor(480, 240)).toBe(240)
    expect(holidayMinutesFor(480, 600)).toBe(480)
  })

  it('keeps only lines inside the period and the employment', () => {
    const lines = liveLines({
      period: PERIOD,
      employee: { ...EMPLOYEE, terminationDate: d('2026-10-15'), standardMinutesPerDay: 240 },
      approvedLeave: [
        { date: d('2026-10-06'), minutes: 240, leaveRequestId: 'a', leaveTypeId: 't', leaveTypeName: 'PTO' },
        { date: d('2026-10-08'), minutes: 240, leaveRequestId: 'a', leaveTypeId: 't', leaveTypeName: 'PTO' },
      ],
      holidays: [
        { date: d('2026-10-12'), minutes: 480, name: 'In' },
        { date: d('2026-10-19'), minutes: 480, name: 'After termination' },
      ],
    })
    expect(lines.leave.map((l) => iso(l.date))).toEqual(['2026-10-08'])
    expect(lines.holidays).toEqual([{ date: d('2026-10-12'), minutes: 240, name: 'In' }])
  })
})

describe('timesheetGridInput', () => {
  const schema = timesheetGridInput({ incrementMinutes: 15, minutesPerDay: 480 }, [
    '2026-10-07',
    '2026-10-08',
    '2026-10-09',
  ])

  it('reads each day, treating a blank as nothing worked', () => {
    const parsed = schema.parse({
      'worked-2026-10-07': '7h 30m',
      'worked-2026-10-08': '',
      'worked-2026-10-09': '8:15',
      'note-2026-10-09': ' Setup for the fall festival ',
      'worked-2026-10-30': '8', // not a day of this period: never read
    })
    expect(parsed).toEqual([
      { date: '2026-10-07', minutes: 450, note: null },
      { date: '2026-10-08', minutes: 0, note: null },
      { date: '2026-10-09', minutes: 495, note: 'Setup for the fall festival' },
    ])
  })

  it('refuses time off the increment, over a day, unparseable, or a note with no time', () => {
    const result = schema.safeParse({
      'worked-2026-10-07': '7h 20m',
      'worked-2026-10-08': '25h',
      'worked-2026-10-09': 'all day',
      'note-2026-10-08': 'x',
    })
    expect(result.success).toBe(false)
    const paths = result.error!.issues.map((i) => i.path.join('.'))
    expect(paths).toEqual(
      expect.arrayContaining(['worked-2026-10-07', 'worked-2026-10-08', 'worked-2026-10-09']),
    )

    const note = schema.safeParse({ 'note-2026-10-07': 'Forgot to clock in' })
    expect(note.error!.issues.map((i) => i.path.join('.'))).toEqual(['note-2026-10-07'])
  })

  it('follows the increment it is given (rule 1)', () => {
    const coarse = timesheetGridInput({ incrementMinutes: 30, minutesPerDay: 480 }, ['2026-10-07'])
    expect(coarse.safeParse({ 'worked-2026-10-07': '7h 15m' }).success).toBe(false)
    expect(coarse.safeParse({ 'worked-2026-10-07': '7h 30m' }).success).toBe(true)
  })
})

describe('CSV', () => {
  it('quotes what needs quoting and defuses formulas', () => {
    expect(csvField('plain')).toBe('plain')
    expect(csvField('Smith, Jo')).toBe('"Smith, Jo"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvField(-30)).toBe('-30')
    expect(csvField(null)).toBe('')
    expect(toCsv([['a', 1], ['b', 2]])).toBe('a,1\r\nb,2\r\n')
  })

  it('exports a row per employee with a column per leave type that appears', () => {
    const rows = periodCsvRows(PERIOD, [
      {
        employee: { id: '1', firstName: 'Sam', lastName: 'Okafor', email: 's@example.test' },
        status: 'APPROVED',
        timeliness: 'LATE',
        totals: {
          worked: 4920,
          overtime: 120,
          regular: 4800,
          holiday: 480,
          leave: 720,
          leaveByType: [
            { leaveTypeId: 'pto', leaveTypeName: 'PTO', minutes: 480 },
            { leaveTypeId: 'sick', leaveTypeName: 'Sick', minutes: 240 },
          ],
        },
      },
      {
        employee: { id: '2', firstName: 'Jess', lastName: 'Moreau', email: 'j@example.test' },
        status: null,
        totals: null,
        timeliness: null,
      },
    ])
    expect(rows[0]).toEqual([
      'Period start',
      'Period end',
      'Last name',
      'First name',
      'Email',
      'Status',
      'Submitted',
      'Regular hours',
      'Overtime hours',
      'Holiday hours',
      'PTO hours',
      'Sick hours',
      'Regular minutes',
      'Overtime minutes',
      'Holiday minutes',
      'PTO minutes',
      'Sick minutes',
    ])
    expect(rows[1]).toEqual([
      '2026-10-07', '2026-10-20', 'Okafor', 'Sam', 's@example.test', 'APPROVED', 'LATE',
      '80.00', '2.00', '8.00', '8.00', '4.00',
      4800, 120, 480, 480, 240,
    ])
    expect(rows[2].slice(5, 8)).toEqual(['NOT CREATED', '', '0.00'])
  })
})
