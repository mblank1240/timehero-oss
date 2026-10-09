import { describe, expect, it } from 'vitest'

import { parseCsv, parseCsvRecords, toCsv } from '@/lib/csv'
import { parseBalanceRows, parseEmployeeRows } from '@/lib/import/rows'

describe('parseCsv', () => {
  it('reads quoted commas, doubled quotes and line breaks', () => {
    expect(parseCsv('a,"b, c","say ""hi""","two\nlines"\r\nx,y,z,w\n')).toEqual([
      ['a', 'b, c', 'say "hi"', 'two\nlines'],
      ['x', 'y', 'z', 'w'],
    ])
  })

  it('drops the byte-order mark Excel writes, and blank lines', () => {
    expect(parseCsv('﻿a,b\n\n,\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('reads back what toCsv writes', () => {
    const rows = [['plain', 'with, comma', 'with "quotes"', 'two\r\nlines']]
    expect(parseCsv(toCsv(rows))).toEqual(rows)
  })

  it('refuses a file that ends inside quotes', () => {
    expect(() => parseCsv('a,"unfinished')).toThrow(/quoted field/)
  })

  it('keys records by a normalized header', () => {
    expect(parseCsvRecords('Email,Hire Date,first-name\nx@y.z, 2020-01-01 ,Al')).toEqual([
      { email: 'x@y.z', hire_date: '2020-01-01', first_name: 'Al' },
    ])
  })
})

const base = {
  email: 'Sam@Example.org',
  first_name: 'Sam',
  last_name: 'Staff',
  employment_type: 'hourly',
  hire_date: '2024-01-15',
}

describe('parseEmployeeRows', () => {
  it('reads a minimal row with every default', () => {
    const { rows, errors } = parseEmployeeRows([base])
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({
      line: 2,
      email: 'sam@example.org',
      role: 'EMPLOYEE',
      employmentType: 'HOURLY',
      standardMinutesPerDay: null,
      policies: [],
      approverEmails: [],
      terminationDate: null,
    })
  })

  it('reads policies with overrides in the row’s own days', () => {
    const { rows } = parseEmployeeRows([
      { ...base, standard_day: '4h', policies: 'pto:Standard=11d; SICK:10+ Years' },
    ])
    expect(rows[0].standardMinutesPerDay).toBe(240)
    expect(rows[0].policies).toEqual([
      { leaveTypeCode: 'PTO', policyName: 'Standard', annualMinutesOverride: 11 * 240 },
      { leaveTypeCode: 'SICK', policyName: '10+ Years', annualMinutesOverride: null },
    ])
  })

  it('refuses an override in days when the row does not say how long a day is', () => {
    const { errors } = parseEmployeeRows([{ ...base, policies: 'PTO:Standard=11d' }])
    expect(errors[0].message).toMatch(/needs standard_day/)
  })

  it('accepts "exempt" for salaried exempt', () => {
    expect(parseEmployeeRows([{ ...base, employment_type: 'Exempt' }]).rows[0].employmentType).toBe(
      'SALARIED_EXEMPT',
    )
  })

  it('reports every bad row with its line number', () => {
    const { rows, errors } = parseEmployeeRows([
      base,
      { ...base, email: 'not-an-email' },
      { ...base, email: 'b@example.org', hire_date: '15/01/2024' },
      { ...base, email: 'c@example.org', approvers: 'c@example.org' },
      { ...base, email: 'SAM@example.org' },
    ])
    expect(rows).toHaveLength(1)
    expect(errors.map((e) => e.line)).toEqual([3, 4, 5, 6])
    expect(errors[2].message).toMatch(/own requests/)
    expect(errors[3].message).toMatch(/already on line 2/)
  })

  it('refuses a termination before the hire', () => {
    const { errors } = parseEmployeeRows([{ ...base, termination_date: '2023-01-01' }])
    expect(errors[0].message).toMatch(/precede/)
  })

  it('reads an employee type, and has no type without the column', () => {
    expect(parseEmployeeRows([base]).rows[0].employeeType).toBeNull()
    const { rows } = parseEmployeeRows([{ ...base, type: ' Associate ' }])
    expect(rows[0]).toMatchObject({ employeeType: 'Associate', employmentType: 'HOURLY' })
  })

  it('lets a row with a type leave the employment type to it', () => {
    const { rows, errors } = parseEmployeeRows([{ ...base, employment_type: '', type: 'Pastor' }])
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({ employeeType: 'Pastor', employmentType: null })
  })

  it('still requires an employment type on a row without a type', () => {
    const { employment_type: _omitted, ...withoutType } = base
    for (const row of [withoutType, { ...base, employment_type: '' }]) {
      const { rows, errors } = parseEmployeeRows([row])
      expect(rows).toEqual([])
      expect(errors[0].message).toMatch(/^employment_type: Required, unless/)
    }
  })

  it('still refuses an employment type it does not recognise beside a type', () => {
    const { errors } = parseEmployeeRows([{ ...base, employment_type: 'volunteer', type: 'Pastor' }])
    expect(errors[0].message).toMatch(/^employment_type/)
  })
})

describe('parseBalanceRows', () => {
  it('reads balances and refuses a second row for the same type', () => {
    const { rows, errors } = parseBalanceRows([
      { email: 'a@b.org', leave_type: 'pto', balance: '3d' },
      { email: 'a@b.org', leave_type: 'COMP', balance: '-4h', expires_on: '2027-02-28' },
      { email: 'A@b.org', leave_type: 'PTO', balance: '1d' },
    ])
    expect(rows.map((r) => [r.leaveTypeCode, r.balanceText])).toEqual([
      ['PTO', '3d'],
      ['COMP', '-4h'],
    ])
    expect(errors).toEqual([
      { file: 'balances', line: 4, message: 'a@b.org already has a PTO balance on line 2.' },
    ])
  })
})
