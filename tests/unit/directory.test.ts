import { describe, expect, it } from 'vitest'

import {
  decideExternalSignIn,
  disabledInDirectory,
  type ExternalSignIn,
} from '@/lib/directory/link'
import {
  employeeFromDirectoryUser,
  planDirectorySync,
  type DirectoryUser,
} from '@/lib/directory/plan'

import { d, iso } from './support/accrual'

const TENANT = '11111111-2222-3333-4444-555555555555'
const CONNECTION = { tenantId: TENANT, domains: ['church.org'], autoProvision: true }

function microsoft(overrides: Partial<ExternalSignIn> = {}): ExternalSignIn {
  return {
    provider: 'MICROSOFT',
    subject: 'oid-1',
    tenant: TENANT,
    email: 'sam@church.org',
    emailVerified: true,
    ...overrides,
  }
}

function decide(
  signIn: ExternalSignIn,
  opts: Partial<Omit<Parameters<typeof decideExternalSignIn>[0], 'signIn'>> = {},
) {
  return decideExternalSignIn({
    signIn,
    connection: CONNECTION,
    issuerIsMultiTenant: false,
    boundEmployeeId: null,
    emailEmployeeId: null,
    ...opts,
  })
}

describe('decideExternalSignIn', () => {
  it('signs a bound account straight in, whatever its address now is', () => {
    expect(decide(microsoft({ email: 'renamed@church.org' }), { boundEmployeeId: 'e1' })).toEqual({
      kind: 'EXISTING',
      employeeId: 'e1',
    })
  })

  it('links by address within the registered tenant and domains', () => {
    expect(decide(microsoft(), { emailEmployeeId: 'e1' })).toEqual({
      kind: 'LINK',
      employeeId: 'e1',
    })
    // Case does not matter.
    expect(decide(microsoft({ email: 'Sam@Church.ORG' }), { emailEmployeeId: 'e1' }).kind).toBe(
      'LINK',
    )
  })

  it('refuses another tenant outright, even with a matching address', () => {
    expect(decide(microsoft({ tenant: 'someone-else' }), { emailEmployeeId: 'e1' })).toEqual({
      kind: 'DENY',
      reason: 'WRONG_TENANT',
    })
    expect(decide(microsoft({ tenant: 'someone-else' }), { boundEmployeeId: 'e1' }).kind).toBe(
      'DENY',
    )
  })

  it('does not link an address outside the organization’s domains — a guest, say', () => {
    expect(decide(microsoft({ email: 'sam@gmail.com' }), { emailEmployeeId: 'e1' })).toEqual({
      kind: 'DENY',
      reason: 'NOT_LINKED',
    })
  })

  it('creates the employee from a Microsoft directory that allows it, and not otherwise', () => {
    expect(decide(microsoft())).toEqual({ kind: 'PROVISION', email: 'sam@church.org' })
    expect(decide(microsoft(), { connection: { ...CONNECTION, autoProvision: false } }).kind).toBe(
      'DENY',
    )
  })

  it('without a registered directory, links by exact address for a single-tenant app', () => {
    expect(
      decide(microsoft({ tenant: 'any' }), { connection: null, emailEmployeeId: 'e1' }),
    ).toEqual({ kind: 'LINK', employeeId: 'e1' })
    expect(decide(microsoft(), { connection: null }).kind).toBe('DENY')
  })

  it('refuses to link by address for a multi-tenant app with no directory registered', () => {
    expect(
      decide(microsoft(), { connection: null, issuerIsMultiTenant: true, emailEmployeeId: 'e1' }),
    ).toEqual({ kind: 'DENY', reason: 'UNTRUSTED_TENANT' })
    // An account bound earlier is still that employee.
    expect(
      decide(microsoft(), { connection: null, issuerIsMultiTenant: true, boundEmployeeId: 'e1' })
        .kind,
    ).toBe('EXISTING')
  })

  describe('Google', () => {
    const google = (overrides: Partial<ExternalSignIn> = {}): ExternalSignIn => ({
      provider: 'GOOGLE',
      subject: 'sub-1',
      tenant: 'church.org',
      email: 'sam@church.org',
      emailVerified: true,
      ...overrides,
    })
    const workspace = { tenantId: 'church.org', domains: ['church.org'], autoProvision: false }

    it('links a Workspace account from a registered domain', () => {
      expect(decide(google(), { connection: workspace, emailEmployeeId: 'e1' }).kind).toBe('LINK')
    })

    it('refuses a personal account or another Workspace when domains are registered', () => {
      expect(
        decide(google({ tenant: null }), { connection: workspace, emailEmployeeId: 'e1' }).kind,
      ).toBe('DENY')
      expect(
        decide(google({ tenant: 'other.org' }), { connection: workspace, emailEmployeeId: 'e1' }),
      ).toEqual({ kind: 'DENY', reason: 'WRONG_TENANT' })
    })

    it('links nobody by address without a Workspace registered — a personal account on a work address, say', () => {
      expect(
        decide(google({ tenant: null }), { connection: null, emailEmployeeId: 'e1' }),
      ).toEqual({ kind: 'DENY', reason: 'UNTRUSTED_TENANT' })
      expect(decide(google(), { connection: null, emailEmployeeId: 'e1' })).toEqual({
        kind: 'DENY',
        reason: 'UNTRUSTED_TENANT',
      })
      // An account bound earlier is still that employee.
      expect(decide(google({ tenant: null }), { connection: null, boundEmployeeId: 'e1' })).toEqual(
        { kind: 'EXISTING', employeeId: 'e1' },
      )
    })

    it('needs the address itself in a registered domain, not only the Workspace', () => {
      expect(
        decide(google({ email: 'sam@gmail.com' }), { connection: workspace, emailEmployeeId: 'e1' }),
      ).toEqual({ kind: 'DENY', reason: 'NOT_LINKED' })
    })

    it('never links an address Google does not vouch for, and never provisions', () => {
      expect(
        decide(google({ emailVerified: false }), { connection: null, emailEmployeeId: 'e1' }).kind,
      ).toBe('DENY')
      expect(decide(google(), { connection: { ...workspace, autoProvision: true } }).kind).toBe(
        'DENY',
      )
    })
  })
})

describe('disabledInDirectory', () => {
  it('is true once the sync has seen any linked account disabled', () => {
    expect(disabledInDirectory([])).toBe(false)
    expect(disabledInDirectory([{ directoryAccountEnabled: null }])).toBe(false)
    expect(disabledInDirectory([{ directoryAccountEnabled: true }])).toBe(false)
    expect(
      disabledInDirectory([{ directoryAccountEnabled: true }, { directoryAccountEnabled: false }]),
    ).toBe(true)
  })
})

function user(overrides: Partial<DirectoryUser> = {}): DirectoryUser {
  return {
    id: 'u1',
    displayName: 'Sam Okafor',
    givenName: 'Sam',
    surname: 'Okafor',
    mail: 'sam@church.org',
    userPrincipalName: 'sam@church.org',
    accountEnabled: true,
    userType: 'Member',
    employeeHireDate: null,
    ...overrides,
  }
}

describe('planDirectorySync', () => {
  const plan = (
    users: DirectoryUser[],
    employees: Parameters<typeof planDirectorySync>[0]['employees'] = [],
    autoProvision = true,
  ) => planDirectorySync({ users, employees, domains: ['church.org'], autoProvision })

  it('creates the unknown, links the known, and refreshes the bound', () => {
    const result = plan(
      [
        user(),
        user({ id: 'u2', mail: 'dana@church.org' }),
        user({ id: 'u3', mail: 'robin@church.org' }),
      ],
      [
        { id: 'dana', email: 'dana@church.org', isActive: true, subjects: [] },
        { id: 'robin', email: 'robin@church.org', isActive: true, subjects: ['u3'] },
      ],
    )
    expect(result.create.map((u) => u.id)).toEqual(['u1'])
    expect(result.link).toEqual([
      { employeeId: 'dana', user: expect.objectContaining({ id: 'u2' }) },
    ])
    expect(result.refresh).toEqual([{ subject: 'u3', enabled: true, email: 'robin@church.org' }])
  })

  it('skips guests, disabled accounts nobody holds, outside domains and shared addresses', () => {
    const result = plan([
      user({ id: 'g', userType: 'Guest', mail: 'g@church.org' }),
      user({ id: 'x', accountEnabled: false, mail: 'shared-mailbox@church.org' }),
      user({ id: 'o', mail: 'someone@elsewhere.org' }),
      user({ id: 'd1', mail: 'office@church.org' }),
      user({ id: 'd2', mail: 'office@church.org' }),
    ])
    expect(result.create).toEqual([])
    expect(result.skipped).toEqual({
      guests: 1,
      disabledUnbound: 1,
      outsideDomains: 1,
      duplicateAddress: 2,
    })
  })

  it('flags an active employee whose account was disabled, without deactivating anyone', () => {
    const result = plan(
      [user({ accountEnabled: false })],
      [{ id: 'sam', email: 'sam@church.org', isActive: true, subjects: ['u1'] }],
    )
    expect(result.flagDisabled).toEqual(['sam'])
    expect(result.refresh[0].enabled).toBe(false)
  })

  it('creates nobody when the connection does not allow it', () => {
    expect(plan([user()], [], false).create).toEqual([])
  })

  it('leaves an employee already bound to another account of this kind to a person', () => {
    const result = plan(
      [user()],
      [{ id: 'sam', email: 'sam@church.org', isActive: true, subjects: ['old'] }],
    )
    expect(result.link).toEqual([])
    expect(result.skipped.duplicateAddress).toBe(1)
  })
})

describe('employeeFromDirectoryUser', () => {
  it('starts hourly, marked for review, with the directory’s hire date if HR set one', () => {
    const e = employeeFromDirectoryUser(
      user({ employeeHireDate: '2024-01-15T00:00:00Z' }),
      d('2026-10-07'),
    )
    expect(e).toMatchObject({
      email: 'sam@church.org',
      firstName: 'Sam',
      lastName: 'Okafor',
      role: 'EMPLOYEE',
      employmentType: 'HOURLY',
      needsReview: true,
    })
    expect(iso(e.hireDate)).toBe('2024-01-15')
  })

  it('falls back to the display name and the sync date', () => {
    const e = employeeFromDirectoryUser(
      user({
        givenName: null,
        surname: null,
        displayName: 'Jess van der Berg',
        mail: null,
        userPrincipalName: 'Jess@Church.org',
      }),
      d('2026-10-07'),
    )
    expect(e).toMatchObject({
      firstName: 'Jess',
      lastName: 'van der Berg',
      email: 'jess@church.org',
    })
    expect(iso(e.hireDate)).toBe('2026-10-07')
  })
})
