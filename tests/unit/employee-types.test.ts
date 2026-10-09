import { describe, expect, it } from 'vitest'

import {
  checkTypePolicies,
  describeSkipped,
  planTypeAssignments,
  type TypePolicy,
} from '@/lib/employee-types/plan'
import { employeeTypeInput } from '@/lib/employee-types/schema'
import { accruableBy, overlapsAny } from '@/lib/employees/assignments'

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

const LEAVE = {
  pto: 'cl0000000000000000000pto0',
  sick: 'cl000000000000000000sick0',
  comp: 'cl000000000000000000comp0',
}
const POLICY = {
  pto: 'cl00000000000000000ptopol',
  sick: 'cl0000000000000000sickpol',
  comp: 'cl0000000000000000comppol',
}

function typePolicy(overrides: Partial<TypePolicy> = {}): TypePolicy {
  return {
    leavePolicyId: POLICY.pto,
    policyName: 'Standard',
    policyIsActive: true,
    leaveTypeId: LEAVE.pto,
    leaveTypeName: 'PTO',
    leaveTypeIsActive: true,
    accruableBy: 'ALL',
    ...overrides,
  }
}

const comp = typePolicy({
  leavePolicyId: POLICY.comp,
  policyName: 'Banked',
  leaveTypeId: LEAVE.comp,
  leaveTypeName: 'Comp Time',
  accruableBy: 'EXEMPT_ONLY',
})

describe('accruableBy', () => {
  it('keeps exempt-only types from hourly staff (rule 4), and the mirror', () => {
    expect(accruableBy('ALL', 'HOURLY')).toBe(true)
    expect(accruableBy('EXEMPT_ONLY', 'HOURLY')).toBe(false)
    expect(accruableBy('EXEMPT_ONLY', 'SALARIED_EXEMPT')).toBe(true)
    expect(accruableBy('HOURLY_ONLY', 'SALARIED_EXEMPT')).toBe(false)
    expect(accruableBy('HOURLY_ONLY', 'HOURLY')).toBe(true)
  })
})

describe('overlapsAny', () => {
  const existing = [{ effectiveFrom: d('2026-01-01'), effectiveTo: d('2026-06-30') }]

  it('counts both ends as days held', () => {
    expect(overlapsAny({ effectiveFrom: d('2026-06-30'), effectiveTo: null }, existing)).toBe(true)
    expect(overlapsAny({ effectiveFrom: d('2025-01-01'), effectiveTo: d('2026-01-01') }, existing)).toBe(
      true,
    )
  })

  it('lets one assignment follow another', () => {
    expect(overlapsAny({ effectiveFrom: d('2026-07-01'), effectiveTo: null }, existing)).toBe(false)
    expect(overlapsAny({ effectiveFrom: d('2025-01-01'), effectiveTo: d('2025-12-31') }, existing)).toBe(
      false,
    )
  })

  it('treats an open end as running forever', () => {
    const open = [{ effectiveFrom: d('2026-01-01'), effectiveTo: null }]
    expect(overlapsAny({ effectiveFrom: d('2030-01-01'), effectiveTo: null }, open)).toBe(true)
    expect(overlapsAny({ effectiveFrom: d('2020-01-01'), effectiveTo: null }, [])).toBe(false)
  })
})

describe('planTypeAssignments', () => {
  const sick = typePolicy({ leavePolicyId: POLICY.sick, leaveTypeId: LEAVE.sick, leaveTypeName: 'Sick' })

  it('starts each policy on the hire date, open-ended, at the policy allotment', () => {
    const { assignments, skipped } = planTypeAssignments({
      policies: [typePolicy(), sick, comp],
      employmentType: 'SALARIED_EXEMPT',
      hireDate: d('2026-10-01'),
    })
    expect(skipped).toEqual([])
    expect(assignments).toEqual(
      [POLICY.pto, POLICY.sick, POLICY.comp].map((leavePolicyId) => ({
        leavePolicyId,
        effectiveFrom: d('2026-10-01'),
        effectiveTo: null,
        annualMinutesOverride: null,
      })),
    )
  })

  it('skips what the employment type actually chosen cannot hold (rule 4)', () => {
    const { assignments, skipped } = planTypeAssignments({
      policies: [typePolicy(), comp],
      employmentType: 'HOURLY',
      hireDate: d('2026-10-01'),
    })
    expect(assignments.map((a) => a.leavePolicyId)).toEqual([POLICY.pto])
    expect(skipped).toEqual([
      { leavePolicyId: POLICY.comp, label: 'Comp Time: Banked', reason: 'not-accruable' },
    ])
    expect(describeSkipped(skipped[0])).toBe(
      'Comp Time: Banked was not assigned: this employment type cannot accrue it.',
    )
  })

  it('skips a policy, or a leave type, retired since the type was saved', () => {
    const { assignments, skipped } = planTypeAssignments({
      policies: [typePolicy({ policyIsActive: false }), { ...sick, leaveTypeIsActive: false }],
      employmentType: 'HOURLY',
      hireDate: d('2026-10-01'),
    })
    expect(assignments).toEqual([])
    expect(skipped.map((s) => s.reason)).toEqual(['inactive', 'inactive'])
    expect(describeSkipped(skipped[0])).toMatch(/retired/)
  })

  it('plans nothing for a type with no policies', () => {
    expect(
      planTypeAssignments({ policies: [], employmentType: 'HOURLY', hireDate: d('2026-10-01') }),
    ).toEqual({ assignments: [], skipped: [] })
  })
})

describe('checkTypePolicies', () => {
  const pto = {
    leaveTypeId: LEAVE.pto,
    name: 'Standard',
    isActive: true,
    leaveType: { name: 'PTO', accruableBy: 'ALL' as const },
  }
  const compPolicy = {
    leaveTypeId: LEAVE.comp,
    name: 'Banked',
    isActive: true,
    leaveType: { name: 'Comp Time', accruableBy: 'EXEMPT_ONLY' as const },
  }

  it('accepts policies that fit their leave type and the employment type', () => {
    expect(
      checkTypePolicies('SALARIED_EXEMPT', [
        { leaveTypeId: LEAVE.pto, policy: pto, alreadyChosen: false },
        { leaveTypeId: LEAVE.comp, policy: compPolicy, alreadyChosen: false },
      ]),
    ).toEqual({})
  })

  it('refuses a comp policy on an hourly type, against its field', () => {
    const errors = checkTypePolicies('HOURLY', [
      { leaveTypeId: LEAVE.comp, policy: compPolicy, alreadyChosen: true },
    ])
    expect(errors[`policy.${LEAVE.comp}`]?.[0]).toBe(
      'Comp Time cannot be accrued by hourly staff. Choose None, or change the employment type.',
    )
  })

  it('refuses a policy filed under a different leave type', () => {
    const errors = checkTypePolicies('HOURLY', [
      { leaveTypeId: LEAVE.sick, policy: pto, alreadyChosen: false },
    ])
    expect(errors[`policy.${LEAVE.sick}`]).toEqual(['That policy belongs to a different leave type.'])
  })

  it('refuses a missing policy, and a retired one unless it was already chosen', () => {
    const retired = { ...pto, isActive: false }
    expect(
      checkTypePolicies('HOURLY', [{ leaveTypeId: LEAVE.pto, policy: null, alreadyChosen: false }]),
    ).toEqual({ [`policy.${LEAVE.pto}`]: ['That policy no longer exists.'] })
    expect(
      checkTypePolicies('HOURLY', [{ leaveTypeId: LEAVE.pto, policy: retired, alreadyChosen: false }]),
    ).toEqual({ [`policy.${LEAVE.pto}`]: ['Standard has been retired. Choose an active policy.'] })
    expect(
      checkTypePolicies('HOURLY', [{ leaveTypeId: LEAVE.pto, policy: retired, alreadyChosen: true }]),
    ).toEqual({})
  })
})

describe('employeeTypeInput', () => {
  const form = {
    name: '  Director ',
    employmentType: 'SALARIED_EXEMPT',
    sortOrder: '2',
    isActive: 'true',
    [`policy.${LEAVE.pto}`]: POLICY.pto,
    [`policy.${LEAVE.sick}`]: POLICY.sick,
    [`policy.${LEAVE.comp}`]: '',
  }

  it('folds one select per leave type into a list, dropping "None"', () => {
    const result = employeeTypeInput.safeParse(form)
    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      name: 'Director',
      employmentType: 'SALARIED_EXEMPT',
      sortOrder: 2,
      isActive: true,
      policies: [
        { leaveTypeId: LEAVE.pto, leavePolicyId: POLICY.pto },
        { leaveTypeId: LEAVE.sick, leavePolicyId: POLICY.sick },
      ],
    })
  })

  it('reads a missing Active checkbox as retired', () => {
    const { isActive: _omitted, ...rest } = form
    expect(employeeTypeInput.safeParse(rest).data?.isActive).toBe(false)
  })

  it('refuses a blank name, an unknown employment type and a malformed id', () => {
    expect(employeeTypeInput.safeParse({ ...form, name: ' ' }).success).toBe(false)
    expect(employeeTypeInput.safeParse({ ...form, employmentType: 'VOLUNTEER' }).success).toBe(false)
    expect(employeeTypeInput.safeParse({ ...form, [`policy.${LEAVE.pto}`]: 'x' }).success).toBe(false)
  })
})
