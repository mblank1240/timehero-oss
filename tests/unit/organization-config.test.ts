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
})
