import { describe, expect, it } from 'vitest'

import {
  EXAMPLE_CONFIG,
  loadOrganizationConfig,
  organizationConfig,
} from '../../prisma/config/organization'

describe('organization configuration', () => {
  const example = loadOrganizationConfig(EXAMPLE_CONFIG)

  it('accepts the shipped example', () => {
    expect(example.organization.mailFromAddress).toBeNull()
    expect(example.leaveTypes.filter((type) => type.bankOvertime)).toHaveLength(1)
  })

  it('refuses a policy for a leave type that does not exist', () => {
    const config = { ...example, policies: [{ ...example.policies[0], leaveType: 'VACATION' }] }
    const result = organizationConfig.safeParse(config)
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('No leave type with code VACATION.')
  })

  it('refuses banking overtime into a type non-exempt staff can accrue (rule 4)', () => {
    const leaveTypes = example.leaveTypes.map((type) =>
      type.bankOvertime ? { ...type, accruableBy: 'ALL' as const } : type,
    )
    expect(organizationConfig.safeParse({ ...example, leaveTypes }).success).toBe(false)
  })

  it('refuses more than one leave type banking overtime', () => {
    const leaveTypes = example.leaveTypes.map((type) => ({
      ...type,
      accruableBy: 'EXEMPT_ONLY' as const,
      bankOvertime: true,
    }))
    expect(organizationConfig.safeParse({ ...example, leaveTypes }).success).toBe(false)
  })

  it('ships employee types whose defaults exist and fit their employment type', () => {
    expect(example.employeeTypes.map((type) => type.name)).toEqual(['Pastor', 'Director', 'Associate'])
  })

  it('treats a file without employee types as having none', () => {
    const { employeeTypes: _omitted, ...rest } = example
    expect(organizationConfig.parse(rest).employeeTypes).toEqual([])
  })

  it('refuses an employee type naming a policy the file does not define', () => {
    const employeeTypes = [{ name: 'Staff', employmentType: 'HOURLY' as const, policies: { PTO: 'Gold' } }]
    const result = organizationConfig.safeParse({ ...example, employeeTypes })
    expect(result.error?.issues[0]?.message).toBe('No PTO policy is called Gold.')
  })

  it('refuses an employee type naming a leave type that does not exist', () => {
    const employeeTypes = [
      { name: 'Staff', employmentType: 'HOURLY' as const, policies: { VACATION: 'Standard' } },
    ]
    const result = organizationConfig.safeParse({ ...example, employeeTypes })
    expect(result.error?.issues[0]?.message).toBe('No leave type with code VACATION.')
  })

  it('refuses an hourly employee type defaulting to an exempt-only type (rule 4)', () => {
    const policies = [
      ...example.policies,
      { ...example.policies[0], leaveType: 'COMP', name: 'Banked' },
    ]
    const employeeTypes = [
      { name: 'Staff', employmentType: 'HOURLY' as const, policies: { COMP: 'Banked' } },
    ]
    const result = organizationConfig.safeParse({ ...example, policies, employeeTypes })
    expect(result.error?.issues[0]?.path).toEqual(['employeeTypes', 0, 'policies', 'COMP'])
  })

  it('refuses two employee types of the same name', () => {
    const employeeTypes = [example.employeeTypes[0], { ...example.employeeTypes[1], name: 'pastor' }]
    expect(organizationConfig.safeParse({ ...example, employeeTypes }).success).toBe(false)
  })
})
