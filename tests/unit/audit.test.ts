import { describe, expect, it } from 'vitest'

import { diff } from '@/lib/audit'

describe('diff', () => {
  it('returns only the changed fields', () => {
    const before = { firstName: 'Robin', lastName: 'Alvarez', role: 'EMPLOYEE' }
    const after = { firstName: 'Robin', lastName: 'Alvarez-Shaw', role: 'ADMIN' }

    expect(diff(before, after)).toEqual({
      before: { lastName: 'Alvarez', role: 'EMPLOYEE' },
      after: { lastName: 'Alvarez-Shaw', role: 'ADMIN' },
    })
  })

  it('returns empty objects when nothing changed', () => {
    const row = { firstName: 'Sam', isActive: true }
    expect(diff(row, { ...row })).toEqual({ before: {}, after: {} })
  })

  it('ignores timestamp churn', () => {
    const before = { name: 'Music', updatedAt: new Date('2026-01-01') }
    const after = { name: 'Music', updatedAt: new Date('2026-06-01') }
    expect(diff(before, after)).toEqual({ before: {}, after: {} })
  })

  it('compares dates by value, not identity', () => {
    const before = { hireDate: new Date('2026-03-01') }
    const after = { hireDate: new Date('2026-03-01') }
    expect(diff(before, after)).toEqual({ before: {}, after: {} })
  })

  it('detects a real date change', () => {
    const before = { hireDate: new Date('2026-03-01') }
    const after = { hireDate: new Date('2026-04-01') }
    expect(diff(before, after).after).toHaveProperty('hireDate')
  })

  it('detects a null-to-value transition', () => {
    expect(diff({ departmentId: null }, { departmentId: 'abc' })).toEqual({
      before: { departmentId: null },
      after: { departmentId: 'abc' },
    })
  })
})
