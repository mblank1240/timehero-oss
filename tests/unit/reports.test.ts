import { describe, expect, it } from 'vitest'

import { toCsv } from '@/lib/csv'
import { balancesCsv, ledgerCsv, slug } from '@/lib/reports/csv'
import { dateParam, idParam, query, rangeParams } from '@/lib/reports/filters'
import { forfeitReason, summarise, type LeaveDay } from '@/lib/reports/rows'

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const robin = {
  id: 'e1',
  firstName: 'Robin',
  lastName: 'Lee',
  email: 'music@example.test',
  standardMinutesPerDay: 480,
}

describe('report filters', () => {
  const org = { benefitYearStartMonth: 1, benefitYearStartDay: 1 }

  it('defaults to the benefit year so far', () => {
    expect(rangeParams({}, org, day('2026-10-07'))).toEqual({
      from: day('2026-01-01'),
      to: day('2026-10-07'),
    })
    expect(
      rangeParams({}, { benefitYearStartMonth: 7, benefitYearStartDay: 1 }, day('2026-03-01')),
    ).toEqual({ from: day('2025-07-01'), to: day('2026-03-01') })
  })

  it('turns a backwards range round rather than showing nothing', () => {
    expect(rangeParams({ from: '2026-06-30', to: '2026-06-01' }, org, day('2026-10-07'))).toEqual({
      from: day('2026-06-01'),
      to: day('2026-06-30'),
    })
  })

  it('ignores a date that does not exist, and anything that is not an id', () => {
    expect(dateParam({ asOf: '2026-02-30' }, 'asOf')).toBeNull()
    expect(dateParam({ asOf: ['2026-02-01'] }, 'asOf')).toBeNull()
    expect(idParam({ type: "x' OR 1=1" }, 'type')).toBeNull()
    expect(idParam({ type: 'cmabc123' }, 'type')).toBe('cmabc123')
  })

  it('builds links that carry the same filters', () => {
    expect(query({ report: 'leave', from: day('2026-01-01'), type: null })).toBe(
      '?report=leave&from=2026-01-01',
    )
    expect(query({})).toBe('')
  })
})

describe('forfeitReason', () => {
  it('reads why from the key the job wrote', () => {
    expect(forfeitReason('2027-ROLLOVER')).toBe('ROLLOVER')
    expect(forfeitReason('2027-ROLLOVER-window1')).toBe('ROLLOVER')
    expect(forfeitReason('cmentry1-EXPIRY')).toBe('EXPIRY')
    expect(forfeitReason(null)).toBe('OTHER')
  })
})

describe('summarise', () => {
  it('counts days and sums time per employee and leave type', () => {
    const pto = { id: 't1', name: 'PTO' }
    const sick = { id: 't2', name: 'Sick' }
    const days: LeaveDay[] = [
      { date: day('2026-03-02'), minutes: 480, employee: robin, leaveType: pto, requestId: 'r1' },
      { date: day('2026-03-03'), minutes: 240, employee: robin, leaveType: pto, requestId: 'r1' },
      { date: day('2026-04-01'), minutes: 480, employee: robin, leaveType: sick, requestId: 'r2' },
    ]
    expect(summarise(days)).toEqual([
      { employee: robin, leaveType: pto, days: 2, minutes: 720 },
      { employee: robin, leaveType: sick, days: 1, minutes: 480 },
    ])
  })
})

describe('report CSVs', () => {
  it('writes balances in hours and minutes, a column per type', () => {
    const rows = balancesCsv(
      day('2026-12-31'),
      [
        { id: 't1', name: 'PTO' },
        { id: 't2', name: 'Sick' },
      ],
      [{ employee: robin, minutes: new Map([['t1', 5280]]) }],
    )
    expect(toCsv(rows)).toBe(
      'As of,Last name,First name,Email,PTO hours,Sick hours,PTO minutes,Sick minutes\r\n' +
        '2026-12-31,Lee,Robin,music@example.test,88,0,5280,0\r\n',
    )
  })

  it('writes a negative figure as a number, not as a guarded formula', () => {
    const rows = ledgerCsv(robin, [
      {
        id: 'l1',
        date: day('2026-03-02'),
        leaveType: { id: 't1', name: 'PTO' },
        kind: 'USAGE',
        minutes: -90,
        balance: -90,
        expiresOn: null,
        note: '=HYPERLINK("x")',
        createdBy: null,
      },
    ])
    const line = toCsv(rows).split('\r\n')[1]
    expect(line).toBe(
      `Lee,Robin,music@example.test,2026-03-02,PTO,USAGE,-1.5,-90,-1.5,-90,,"'=HYPERLINK(""x"")",`,
    )
  })

  it('names files in plain ASCII', () => {
    expect(slug('ledger', '2026-10-07', 'Ó Briain', 'Seán')).toBe('ledger-2026-10-07-o-briain-sean')
  })
})
