import { describe, expect, it } from 'vitest'

import { clientIpFrom } from '@/lib/sign-in-links'

describe('clientIpFrom', () => {
  it('takes the right-most entry, which the nearest proxy wrote', () => {
    // A client can send its own X-Forwarded-For; the proxy appends after it.
    expect(clientIpFrom('1.1.1.1, 203.0.113.7')).toBe('203.0.113.7')
    expect(clientIpFrom('203.0.113.7')).toBe('203.0.113.7')
  })

  it('drops the port App Service adds', () => {
    expect(clientIpFrom('spoofed, 203.0.113.7:51234')).toBe('203.0.113.7')
    expect(clientIpFrom('[2001:DB8::1]:443')).toBe('2001:db8::1')
    expect(clientIpFrom('2001:db8::1')).toBe('2001:db8::1')
  })

  it('gives null for anything that is not an address, so it shares one limit', () => {
    expect(clientIpFrom(null)).toBeNull()
    expect(clientIpFrom('')).toBeNull()
    expect(clientIpFrom('203.0.113.7, ')).toBeNull()
    expect(clientIpFrom('203.0.113.7, unknown')).toBeNull()
    expect(clientIpFrom('999.1.1.1')).toBeNull()
  })
})
