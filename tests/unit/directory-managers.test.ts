import { describe, expect, it } from 'vitest'

import { planManagerChains, type ManagerBinding } from '@/lib/directory/managers'

const employees = new Map([
  ['m-pat', { id: 'pat', isActive: true }],
  ['m-lee', { id: 'lee', isActive: true }],
  ['m-gone', { id: 'gone', isActive: false }],
  ['m-sam', { id: 'sam', isActive: true }],
])

function binding(overrides: Partial<ManagerBinding> = {}): ManagerBinding {
  return {
    employeeId: 'sam',
    isActive: true,
    managerSubject: 'm-pat',
    previousManagerSubject: null,
    chain: [],
    ...overrides,
  }
}

describe('planManagerChains', () => {
  it('starts an empty chain with the manager', () => {
    expect(planManagerChains([binding()], employees)).toEqual({
      prefill: [{ employeeId: 'sam', approverId: 'pat' }],
      flag: [],
    })
  })

  it('never touches a chain that has approvers', () => {
    const plan = planManagerChains([binding({ chain: ['lee'], previousManagerSubject: 'm-pat' })], employees)
    expect(plan).toEqual({ prefill: [], flag: [] })
  })

  it('flags a changed manager when the chain does not already start with them', () => {
    const plan = planManagerChains(
      [binding({ managerSubject: 'm-lee', previousManagerSubject: 'm-pat', chain: ['pat'] })],
      employees,
    )
    expect(plan.flag).toEqual(['sam'])
  })

  it('does not flag a change the chain already reflects', () => {
    const plan = planManagerChains(
      [binding({ managerSubject: 'm-lee', previousManagerSubject: 'm-pat', chain: ['lee', 'pat'] })],
      employees,
    )
    expect(plan.flag).toEqual([])
  })

  it('flags a manager removed in the directory', () => {
    const plan = planManagerChains(
      [binding({ managerSubject: null, previousManagerSubject: 'm-pat', chain: ['pat'] })],
      employees,
    )
    expect(plan.flag).toEqual(['sam'])
  })

  it('does not flag on the first sync that reads managers', () => {
    const plan = planManagerChains(
      [binding({ managerSubject: 'm-lee', previousManagerSubject: null, chain: ['pat'] })],
      employees,
    )
    expect(plan.flag).toEqual([])
  })

  it('skips a manager with no record, an inactive one, and oneself', () => {
    expect(planManagerChains([binding({ managerSubject: 'm-nobody' })], employees).prefill).toEqual([])
    expect(planManagerChains([binding({ managerSubject: 'm-gone' })], employees).prefill).toEqual([])
    expect(planManagerChains([binding({ managerSubject: 'm-sam' })], employees).prefill).toEqual([])
  })

  it('leaves inactive employees alone', () => {
    expect(planManagerChains([binding({ isActive: false })], employees)).toEqual({
      prefill: [],
      flag: [],
    })
  })
})
