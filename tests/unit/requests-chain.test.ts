import { describe, expect, it } from 'vitest'

import {
  SELF_SKIP_COMMENT,
  applyDecision,
  currentStep,
  mayDecide,
  snapshotChain,
  type StepState,
} from '@/lib/requests/chain'

const ME = 'requester'

describe('snapshotChain', () => {
  it('freezes the chain in order, renumbered from 1', () => {
    const steps = snapshotChain(
      [
        { step: 5, approverId: 'c' },
        { step: 1, approverId: 'a' },
        { step: 3, approverId: 'b' },
      ],
      ME,
    )

    expect(steps.map((s) => [s.step, s.approverId, s.status])).toEqual([
      [1, 'a', 'PENDING'],
      [2, 'b', 'PENDING'],
      [3, 'c', 'PENDING'],
    ])
  })

  it('skips the requester and says why', () => {
    const steps = snapshotChain(
      [
        { step: 1, approverId: 'a' },
        { step: 2, approverId: ME },
        { step: 3, approverId: 'b' },
      ],
      ME,
    )

    expect(steps[1]).toEqual({
      step: 2,
      approverId: ME,
      status: 'SKIPPED',
      comment: SELF_SKIP_COMMENT,
    })
    expect(steps.filter((s) => s.status === 'PENDING')).toHaveLength(2)
  })

  it('routes an empty chain to any administrator', () => {
    expect(snapshotChain([], ME)).toEqual([
      { step: 1, approverId: null, status: 'PENDING', comment: null },
    ])
  })

  it('routes to administrators when the only approver is the requester', () => {
    expect(
      snapshotChain([{ step: 1, approverId: ME }], ME).map((s) => [s.approverId, s.status]),
    ).toEqual([
      [ME, 'SKIPPED'],
      [null, 'PENDING'],
    ])
  })
})

function state(...statuses: StepState['status'][]): StepState[] {
  return statuses.map((status, i) => ({
    id: `s${i + 1}`,
    step: i + 1,
    approverId: `a${i + 1}`,
    status,
  }))
}

describe('currentStep', () => {
  it('is the lowest pending step', () => {
    expect(currentStep(state('SKIPPED', 'APPROVED', 'PENDING', 'PENDING'))?.id).toBe('s3')
  })

  it('is null once nothing is pending', () => {
    expect(currentStep(state('APPROVED', 'DENIED'))).toBeNull()
  })
})

describe('mayDecide', () => {
  const step = { id: 's1', step: 1, approverId: 'a1', status: 'PENDING' as const }
  const open = { ...step, approverId: null }

  it('lets the named approver act', () => {
    expect(mayDecide(step, { id: 'a1', permissions: [] }, ME)).toBe(true)
  })

  it('does not let anyone else act, those who act for others included', () => {
    expect(mayDecide(step, { id: 'x', permissions: [] }, ME)).toBe(false)
    expect(mayDecide(step, { id: 'x', permissions: ['MANAGE_TIME_RECORDS'] }, ME)).toBe(false)
  })

  it('lets anyone who acts for others act on an open step, but not an employee', () => {
    expect(mayDecide(open, { id: 'x', permissions: ['MANAGE_TIME_RECORDS'] }, ME)).toBe(true)
    expect(mayDecide(open, { id: 'x', permissions: [] }, ME)).toBe(false)
  })

  it('never lets the requester decide, even one who acts for others, on an open step', () => {
    expect(mayDecide(open, { id: ME, permissions: ['MANAGE_TIME_RECORDS'] }, ME)).toBe(false)
    expect(mayDecide({ ...step, approverId: ME }, { id: ME, permissions: [] }, ME)).toBe(false)
  })

  it('refuses a step that is no longer pending', () => {
    expect(mayDecide({ ...step, status: 'APPROVED' }, { id: 'a1', permissions: [] }, ME)).toBe(
      false,
    )
  })
})

describe('applyDecision', () => {
  it('advances to the next pending step', () => {
    const outcome = applyDecision(state('PENDING', 'PENDING', 'PENDING'), 'APPROVE')
    expect(outcome).toMatchObject({
      result: 'ADVANCED',
      decided: { stepId: 's1', status: 'APPROVED' },
    })
    expect(outcome.next?.id).toBe('s2')
  })

  it('approves the request on the last step', () => {
    expect(applyDecision(state('APPROVED', 'APPROVED', 'PENDING'), 'APPROVE').result).toBe(
      'APPROVED',
    )
  })

  it('jumps over a step skipped at submission', () => {
    expect(applyDecision(state('PENDING', 'SKIPPED', 'PENDING'), 'APPROVE').next?.id).toBe('s3')
  })

  it('ends the request at a denial and closes every later step', () => {
    const outcome = applyDecision(state('APPROVED', 'PENDING', 'PENDING', 'PENDING'), 'DENY')
    expect(outcome).toEqual({
      decided: { stepId: 's2', status: 'DENIED' },
      closed: ['s3', 's4'],
      result: 'DENIED',
      next: null,
    })
  })

  it('treats skipping the last step as approving the request', () => {
    const outcome = applyDecision(state('APPROVED', 'PENDING'), 'SKIP')
    expect(outcome).toMatchObject({
      result: 'APPROVED',
      decided: { stepId: 's2', status: 'SKIPPED' },
    })
  })

  it('throws when nothing is pending', () => {
    expect(() => applyDecision(state('APPROVED'), 'APPROVE')).toThrow()
  })
})
