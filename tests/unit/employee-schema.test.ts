import { describe, expect, it } from 'vitest'

import { approvalChainInput, employeeInput } from '@/lib/employees/schema'

function form(overrides: Record<string, string> = {}) {
  return {
    email: 'New.Person@Example.test',
    firstName: 'New',
    lastName: 'Person',
    role: 'EMPLOYEE',
    employmentType: 'HOURLY',
    hireDate: '2026-03-01',
    standardMinutesPerDay: '480',
    isActive: 'true',
    ...overrides,
  }
}

describe('employeeInput', () => {
  it('accepts a valid record and lowercases the email', () => {
    const result = employeeInput.safeParse(form())
    expect(result.success).toBe(true)
    expect(result.data?.email).toBe('new.person@example.test')
  })

  it('parses dates at UTC midnight so DATE columns never shift a day', () => {
    const result = employeeInput.safeParse(form())
    expect(result.data?.hireDate.toISOString()).toBe('2026-03-01T00:00:00.000Z')
  })

  it('treats a missing isActive checkbox as false', () => {
    const { isActive: _omitted, ...withoutCheckbox } = form()
    const result = employeeInput.safeParse(withoutCheckbox)
    expect(result.success).toBe(true)
    expect(result.data?.isActive).toBe(false)
  })

  it('treats a present isActive checkbox as true', () => {
    expect(employeeInput.safeParse(form({ isActive: 'on' })).data?.isActive).toBe(true)
  })

  it('rejects a termination date before the hire date', () => {
    const result = employeeInput.safeParse(
      form({ hireDate: '2026-03-01', terminationDate: '2026-02-01' }),
    )
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['terminationDate'])
  })

  it('accepts a termination date equal to the hire date', () => {
    const result = employeeInput.safeParse(
      form({ hireDate: '2026-03-01', terminationDate: '2026-03-01' }),
    )
    expect(result.success).toBe(true)
  })

  it('accepts an empty termination date', () => {
    expect(employeeInput.safeParse(form({ terminationDate: '' })).success).toBe(true)
  })

  it('rejects an invalid email', () => {
    expect(employeeInput.safeParse(form({ email: 'not-an-email' })).success).toBe(false)
  })

  it('rejects a working day longer than 24 hours', () => {
    expect(
      employeeInput.safeParse(form({ standardMinutesPerDay: '1441' })).success,
    ).toBe(false)
  })

  it('rejects a zero-minute working day', () => {
    expect(employeeInput.safeParse(form({ standardMinutesPerDay: '0' })).success).toBe(
      false,
    )
  })

  it('rejects an unknown role', () => {
    expect(employeeInput.safeParse(form({ role: 'SUPERUSER' })).success).toBe(false)
  })
})

describe('approvalChainInput', () => {
  const employeeId = 'cm5aaaaaaaaaaaaaaaaaaaaaa'
  const a = 'cm5bbbbbbbbbbbbbbbbbbbbbb'
  const b = 'cm5cccccccccccccccccccccc'

  it('accepts an ordered list of distinct approvers', () => {
    expect(
      approvalChainInput.safeParse({ employeeId, approverIds: [a, b] }).success,
    ).toBe(true)
  })

  it('accepts an empty chain', () => {
    expect(approvalChainInput.safeParse({ employeeId, approverIds: [] }).success).toBe(
      true,
    )
  })

  it('rejects a duplicated approver', () => {
    const result = approvalChainInput.safeParse({ employeeId, approverIds: [a, a] })
    expect(result.success).toBe(false)
  })

  it('rejects a chain longer than ten steps', () => {
    const ids = Array.from(
      { length: 11 },
      (_, i) => `cm5${String(i).padStart(22, 'x')}`,
    )
    expect(approvalChainInput.safeParse({ employeeId, approverIds: ids }).success).toBe(
      false,
    )
  })
})
