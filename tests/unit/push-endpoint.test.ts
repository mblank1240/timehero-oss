import { describe, expect, it } from 'vitest'

import { isAllowedPushEndpoint } from '@/lib/notifications/push-endpoint'
import { pushSubscriptionInput } from '@/lib/notifications/schema'

describe('isAllowedPushEndpoint', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc:def',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAAA',
    'https://wns2-by3p.notify.windows.com/w/?token=BQYAAA',
    'https://web.push.apple.com/QGuQyavXu',
    'https://api.push.apple.com/3/device/abc',
    'https://FCM.googleapis.com:443/fcm/send/x',
  ])('accepts the vendor push service %s', (url) => {
    expect(isAllowedPushEndpoint(url)).toBe(true)
  })

  it.each([
    ['plain http', 'http://fcm.googleapis.com/fcm/send/x'],
    ['an unknown host', 'https://example.com/push'],
    ['a look-alike suffix', 'https://evilpush.apple.com.example.com/x'],
    ['a host ending in the suffix text', 'https://notpush.apple.com/x'],
    ['a trailing-dot host', 'https://fcm.googleapis.com./x'],
    ['a non-default port', 'https://fcm.googleapis.com:8443/x'],
    ['credentials', 'https://user:pw@fcm.googleapis.com/x'],
    ['a username alone', 'https://user@fcm.googleapis.com/x'],
    ['an IPv4 literal', 'https://169.254.169.254/metadata'],
    ['an obfuscated IPv4 literal', 'https://0x7f.1/x'],
    ['an IPv6 literal', 'https://[::1]/x'],
    ['localhost', 'https://localhost/x'],
    ['not a URL', 'fcm.googleapis.com/x'],
  ])('refuses %s', (_label, url) => {
    expect(isAllowedPushEndpoint(url)).toBe(false)
  })
})

describe('pushSubscriptionInput', () => {
  const keys = { p256dh: 'BNc', auth: 'tBH' }

  it('accepts a real-shaped subscription', () => {
    const r = pushSubscriptionInput.safeParse({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      keys,
    })
    expect(r.success).toBe(true)
  })

  it('refuses an endpoint inside the network', () => {
    const r = pushSubscriptionInput.safeParse({ endpoint: 'https://10.0.0.4/', keys })
    expect(r.success).toBe(false)
  })
})
