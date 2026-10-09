/**
 * What an employee type means for a new hire, as pure functions.
 *
 * A type is a pre-fill template: when an employee is created from it, they
 * are put on its policies from their hire date, and that is all it ever does.
 * Nothing here is consulted again — editing the type, or the employee's type
 * label, leaves existing assignments exactly as they are.
 *
 * Pure — no database. The service layer (`./service.ts`) and the import
 * (`lib/import/service.ts`) load the rows and write what this returns.
 */

import {
  accruableBy,
  type AccruableBy,
  type EmploymentType,
} from '@/lib/employees/assignments'

/** One of a type's default policies, with what deciding about it needs. */
export type TypePolicy = {
  leavePolicyId: string
  policyName: string
  policyIsActive: boolean
  leaveTypeId: string
  leaveTypeName: string
  leaveTypeIsActive: boolean
  accruableBy: AccruableBy
}

export type PlannedAssignment = {
  leavePolicyId: string
  effectiveFrom: Date
  effectiveTo: null
  annualMinutesOverride: null
}

export type SkippedPolicy = {
  leavePolicyId: string
  /** `PTO: Standard`, for a message. */
  label: string
  reason: 'inactive' | 'not-accruable'
}

/**
 * The assignments a new employee starts with: each of the type's policies,
 * from the hire date, open-ended and at the policy's own allotment.
 *
 * A policy is skipped, and reported, when it or its leave type has been
 * retired since the type was saved, or when the employee's employment type
 * may not hold it — the employment type actually chosen, which may differ
 * from the type's default. That last one is rule 4: a type's comp policy
 * never reaches someone saved as hourly.
 */
export function planTypeAssignments(args: {
  policies: readonly TypePolicy[]
  employmentType: EmploymentType
  hireDate: Date
}): { assignments: PlannedAssignment[]; skipped: SkippedPolicy[] } {
  const assignments: PlannedAssignment[] = []
  const skipped: SkippedPolicy[] = []

  for (const policy of args.policies) {
    const label = `${policy.leaveTypeName}: ${policy.policyName}`
    if (!policy.policyIsActive || !policy.leaveTypeIsActive) {
      skipped.push({ leavePolicyId: policy.leavePolicyId, label, reason: 'inactive' })
    } else if (!accruableBy(policy.accruableBy, args.employmentType)) {
      skipped.push({ leavePolicyId: policy.leavePolicyId, label, reason: 'not-accruable' })
    } else {
      assignments.push({
        leavePolicyId: policy.leavePolicyId,
        effectiveFrom: args.hireDate,
        effectiveTo: null,
        annualMinutesOverride: null,
      })
    }
  }

  return { assignments, skipped }
}

/** A skipped policy as a sentence an administrator can act on. */
export function describeSkipped(skipped: SkippedPolicy): string {
  return skipped.reason === 'inactive'
    ? `${skipped.label} was not assigned: it has been retired.`
    : `${skipped.label} was not assigned: this employment type cannot accrue it.`
}

/** A policy chosen for a type, as the form submitted it and the database has it. */
export type ChosenPolicy = {
  /** The leave type the form put it under. */
  leaveTypeId: string
  policy: {
    leaveTypeId: string
    name: string
    isActive: boolean
    leaveType: { name: string; accruableBy: AccruableBy }
  } | null
  /** Already one of this type's defaults, so a retired one may stay. */
  alreadyChosen: boolean
}

/**
 * What is wrong with a type's chosen policies, keyed by the form field
 * (`policy.<leaveTypeId>`). A policy must exist, belong to the leave type it
 * was chosen for, be active unless it was already there, and be one the
 * type's employment type can hold — a comp policy on an hourly type would
 * otherwise put every hourly hire made from it on comp time (rule 4).
 */
export function checkTypePolicies(
  employmentType: EmploymentType,
  chosen: readonly ChosenPolicy[],
): Record<string, string[]> {
  const errors: Record<string, string[]> = {}
  for (const { leaveTypeId, policy, alreadyChosen } of chosen) {
    const field = `policy.${leaveTypeId}`
    if (!policy) {
      errors[field] = ['That policy no longer exists.']
    } else if (policy.leaveTypeId !== leaveTypeId) {
      errors[field] = ['That policy belongs to a different leave type.']
    } else if (!policy.isActive && !alreadyChosen) {
      errors[field] = [`${policy.name} has been retired. Choose an active policy.`]
    } else if (!accruableBy(policy.leaveType.accruableBy, employmentType)) {
      errors[field] = [
        `${policy.leaveType.name} cannot be accrued by ${
          employmentType === 'HOURLY' ? 'hourly' : 'salaried (exempt)'
        } staff. Choose None, or change the employment type.`,
      ]
    }
  }
  return errors
}
