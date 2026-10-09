import { describe, expect, it } from 'vitest'

import { buildGrid } from '@/lib/timesheets/grid'
import { timeliness, timesheetDueDate } from '@/lib/timesheets/due'
import { employeeCsvName, employeeCsvRows } from '@/lib/timesheets/report'
import { crc32, zip } from '@/lib/zip'

import { d, iso } from './support/accrual'

const NY = 'America/New_York'

describe('due dates', () => {
  // A Sunday-to-Saturday period ending Saturday 17 October, due the Tuesday after.
  const due = timesheetDueDate(d('2026-10-17'), 3)

  it('falls the configured number of days after the period ends', () => {
    expect(iso(due)).toBe('2026-10-20')
    expect(iso(timesheetDueDate(d('2026-10-17'), 0))).toBe('2026-10-17')
  })

  it('is on time through the end of the due day in the org’s timezone', () => {
    // 11:30pm Tuesday in New York is already Wednesday in UTC.
    const lateTuesday = new Date('2026-10-21T03:30:00Z')
    expect(
      timeliness({
        dueDate: due,
        firstSubmittedAt: lateTuesday,
        now: lateTuesday,
        timeZone: NY,
      }),
    ).toBe('ON_TIME')
    const wednesday = new Date('2026-10-21T13:00:00Z')
    expect(
      timeliness({
        dueDate: due,
        firstSubmittedAt: wednesday,
        now: wednesday,
        timeZone: NY,
      }),
    ).toBe('LATE')
  })

  it('is due until the day passes, then overdue', () => {
    expect(
      timeliness({
        dueDate: due,
        firstSubmittedAt: null,
        now: new Date('2026-10-20T20:00:00Z'),
        timeZone: NY,
      }),
    ).toBe('DUE')
    expect(
      timeliness({
        dueDate: due,
        firstSubmittedAt: null,
        now: new Date('2026-10-21T13:00:00Z'),
        timeZone: NY,
      }),
    ).toBe('OVERDUE')
  })
})

describe('the per-employee CSV', () => {
  const grid = buildGrid({
    period: { startDate: d('2026-10-04'), endDate: d('2026-10-17') },
    employee: {
      hireDate: d('2024-01-15'),
      terminationDate: null,
      standardMinutesPerDay: 480,
    },
    worked: [
      { date: d('2026-10-05'), minutes: 600, note: 'Boiler repair' },
      { date: d('2026-10-06'), minutes: 600, note: null },
      { date: d('2026-10-07'), minutes: 600, note: null },
      { date: d('2026-10-08'), minutes: 600, note: null },
      { date: d('2026-10-09'), minutes: 120, note: null },
    ],
    workedBefore: [],
    leave: [
      {
        date: d('2026-10-12'),
        minutes: 480,
        leaveRequestId: 'r',
        leaveTypeId: 'pto',
        leaveTypeName: 'PTO',
      },
    ],
    holidays: [{ date: d('2026-10-13'), minutes: 480, name: 'Founders Day' }],
    rules: { thresholdMinutes: 2400, weekStartDay: 7 },
  })
  const rows = employeeCsvRows(
    {
      employee: {
        firstName: 'Sam',
        lastName: 'Okafor',
        email: 's@example.test',
      },
      payPeriod: { startDate: d('2026-10-04'), endDate: d('2026-10-17') },
      status: 'APPROVED',
    },
    grid,
  )
  const col = (name: string) => rows[0].indexOf(name)

  it('has a row for every day of the period, then a total', () => {
    expect(rows).toHaveLength(1 + 14 + 1)
    expect(rows[1][col('Date')]).toBe('2026-10-04')
    expect(rows[1][col('Day')]).toBe('Sun')
    expect(rows.at(-1)?.[col('Date')]).toBe('TOTAL')
  })

  it('splits each day into regular and overtime, and shows leave and holidays', () => {
    const friday = rows.find((r) => r[col('Date')] === '2026-10-09')!
    expect([
      friday[col('Worked hours')],
      friday[col('Regular hours')],
      friday[col('Overtime hours')],
    ]).toEqual(['2.00', '0.00', '2.00'])
    expect(rows.find((r) => r[col('Date')] === '2026-10-05')![col('Note')]).toBe('Boiler repair')
    expect(rows.find((r) => r[col('Date')] === '2026-10-12')![col('Leave type')]).toBe('PTO')
    expect(rows.find((r) => r[col('Date')] === '2026-10-13')![col('Holiday')]).toBe('Founders Day')

    const total = rows.at(-1)!
    expect(total[col('Worked minutes')]).toBe(2520)
    expect(total[col('Regular minutes')]).toBe(2400)
    expect(total[col('Overtime minutes')]).toBe(120)
    expect(total[col('Leave type')]).toBe('PTO 8.00')
  })

  it('names the file plainly', () => {
    expect(employeeCsvName({ firstName: 'José', lastName: "O'Brien-Núñez" }, d('2026-10-04'))).toBe(
      'timesheet-2026-10-04-o-brien-nunez-jose.csv',
    )
  })
})

describe('zip', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789')).toString(16)).toBe('cbf43926')
  })

  it('lists every file in its central directory', () => {
    const bytes = zip([
      { name: 'a.csv', content: 'x\r\n' },
      { name: 'b.csv', content: 'yy\r\n' },
    ])
    const view = new DataView(bytes.buffer)
    const end = bytes.length - 22
    expect(view.getUint32(end, true)).toBe(0x06054b50)
    expect(view.getUint16(end + 10, true)).toBe(2)

    // Walk the central directory back to each stored file.
    let at = view.getUint32(end + 16, true)
    const names: string[] = []
    for (let i = 0; i < 2; i += 1) {
      expect(view.getUint32(at, true)).toBe(0x02014b50)
      const length = view.getUint16(at + 28, true)
      names.push(new TextDecoder().decode(bytes.slice(at + 46, at + 46 + length)))
      const local = view.getUint32(at + 42, true)
      expect(view.getUint32(local, true)).toBe(0x04034b50)
      at += 46 + length
    }
    expect(names).toEqual(['a.csv', 'b.csv'])
  })
})
