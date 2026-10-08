import { describe, expect, it } from 'vitest'

import { resolveEmployeeForSignIn } from '@/lib/sign-in'

const NOW = new Date('2026-06-15T14:30:00.000Z')

describe('resolveEmployeeForSignIn', () => {
  it('admits an active employee with no termination date', () => {
    expect(
      resolveEmployeeForSignIn({ isActive: true, terminationDate: null }, NOW),
    ).toEqual({ ok: true })
  })

  it('refuses an inactive employee', () => {
    expect(
      resolveEmployeeForSignIn({ isActive: false, terminationDate: null }, NOW),
    ).toEqual({ ok: false, reason: 'inactive' })
  })

  it('refuses an employee terminated in the past', () => {
    expect(
      resolveEmployeeForSignIn(
        { isActive: true, terminationDate: new Date('2026-05-29T00:00:00.000Z') },
        NOW,
      ),
    ).toEqual({ ok: false, reason: 'terminated' })
  })

  it('still admits an employee on their termination date', () => {
    // Someone leaving on the 15th works that day; access ends on the 16th.
    expect(
      resolveEmployeeForSignIn(
        { isActive: true, terminationDate: new Date('2026-06-15T00:00:00.000Z') },
        NOW,
      ),
    ).toEqual({ ok: true })
  })

  it('admits an employee with a future termination date', () => {
    expect(
      resolveEmployeeForSignIn(
        { isActive: true, terminationDate: new Date('2026-12-31T00:00:00.000Z') },
        NOW,
      ),
    ).toEqual({ ok: true })
  })

  it('prefers the inactive reason when both apply', () => {
    expect(
      resolveEmployeeForSignIn(
        { isActive: false, terminationDate: new Date('2020-01-01T00:00:00.000Z') },
        NOW,
      ),
    ).toEqual({ ok: false, reason: 'inactive' })
  })

  it('does not shift across a day boundary for late-evening local times', () => {
    // 23:30 UTC on the termination date is still that date.
    expect(
      resolveEmployeeForSignIn(
        { isActive: true, terminationDate: new Date('2026-06-15T00:00:00.000Z') },
        new Date('2026-06-15T23:30:00.000Z'),
      ),
    ).toEqual({ ok: true })
  })
})
