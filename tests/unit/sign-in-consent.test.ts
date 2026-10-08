import { describe, expect, it } from 'vitest'

import { tenantMismatch } from '@/lib/directory/consent'

const TENANT = '11111111-2222-3333-4444-555555555555'
const OTHER = '99999999-8888-7777-6666-555555555555'

describe('tenantMismatch', () => {
  it('lets any tenant connect to a multi-tenant app, or one with no issuer set', () => {
    expect(tenantMismatch(TENANT, { issuer: 'organizations' })).toBeNull()
    expect(tenantMismatch(TENANT, { issuer: null })).toBeNull()
  })

  it('matches an issuer named by tenant id, whatever the case', () => {
    expect(tenantMismatch(TENANT.toUpperCase(), { issuer: TENANT })).toBeNull()
    expect(tenantMismatch(OTHER, { issuer: TENANT })).toMatch(/consent was granted in/)
  })

  it('refuses an issuer named by domain until the tenant’s domains confirm it', () => {
    expect(tenantMismatch(TENANT, { issuer: 'church.org' })).toMatch(/tenant id instead/)
    expect(tenantMismatch(TENANT, { issuer: 'church.org', domains: ['Church.org'] })).toBeNull()
    expect(tenantMismatch(TENANT, { issuer: 'church.org', domains: ['other.org'] })).toMatch(
      /consent was granted in/,
    )
  })
})
