'use client'

import { useEffect, useState, useTransition } from 'react'

import { sendTestPush, subscribePush, unsubscribePush } from '@/lib/notifications/actions'

type State =
  | 'checking'
  /** No service workers or no Push API in this browser. */
  | 'unsupported'
  /** iPhone or iPad, not opened from the home screen. */
  | 'needs-home-screen'
  /** The person, or the browser, has refused permission. */
  | 'denied'
  | 'off'
  | 'on'

/** The VAPID public key, base64url, as the Push API wants it. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  const raw = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}

function isIosOutsideHomeScreen(): boolean {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches
  return ios && !standalone
}

/**
 * Turns push notifications on or off for this browser. Each browser and
 * device is subscribed separately; the list of them is on the page around
 * this.
 */
export function PushToggle({ publicKey }: { publicKey: string }) {
  const [state, setState] = useState<State>('checking')
  const [message, setMessage] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let next: State
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        next = isIosOutsideHomeScreen() ? 'needs-home-screen' : 'unsupported'
      } else if (Notification.permission === 'denied') {
        next = 'denied'
      } else {
        const registration = await navigator.serviceWorker.getRegistration('/')
        const existing = await registration?.pushManager.getSubscription()
        next = existing ? 'on' : 'off'
      }
      if (!cancelled) setState(next)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  function turnOn() {
    setMessage(null)
    startTransition(async () => {
      try {
        const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
        await navigator.serviceWorker.ready
        const permission = await Notification.requestPermission()
        if (permission !== 'granted') {
          setState(permission === 'denied' ? 'denied' : 'off')
          return
        }
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(publicKey),
        })
        const result = await subscribePush(subscription.toJSON())
        if (!result.ok) {
          await subscription.unsubscribe()
          setMessage(result.error)
          return
        }
        setState('on')
      } catch (error) {
        console.error(error)
        setMessage('This browser would not turn notifications on.')
      }
    })
  }

  function turnOff() {
    setMessage(null)
    startTransition(async () => {
      const registration = await navigator.serviceWorker.getRegistration('/')
      const subscription = await registration?.pushManager.getSubscription()
      if (subscription) {
        await unsubscribePush(subscription.endpoint)
        await subscription.unsubscribe()
      }
      setState('off')
    })
  }

  function test() {
    setMessage(null)
    startTransition(async () => {
      const result = await sendTestPush()
      setMessage(result.ok ? 'Sent — it should appear in a moment.' : result.error)
    })
  }

  return (
    <div className="space-y-2">
      {state === 'checking' && <p className="text-sm text-muted">Checking this browser…</p>}
      {state === 'unsupported' && (
        <p className="text-sm text-muted">
          This browser cannot receive push notifications. Everything still appears in the list
          below, and by email if your organization sends it.
        </p>
      )}
      {state === 'needs-home-screen' && (
        <p className="text-sm text-muted">
          On iPhone and iPad, notifications work only once TimeHero is on your home screen: tap{' '}
          <strong>Share</strong>, then <strong>Add to Home Screen</strong>, open TimeHero from
          there and come back to this page. (iOS 16.4 or later.)
        </p>
      )}
      {state === 'denied' && (
        <p className="text-sm text-muted">
          Notifications are blocked for this site. Allow them in your browser&apos;s site
          settings, then reload this page.
        </p>
      )}
      {state === 'off' && (
        <button type="button" className="th-btn" onClick={turnOn} disabled={pending}>
          {pending ? 'Turning on…' : 'Turn on notifications in this browser'}
        </button>
      )}
      {state === 'on' && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm">Notifications are on in this browser.</span>
          <button type="button" className="th-btn-secondary" onClick={test} disabled={pending}>
            Send a test
          </button>
          <button type="button" className="th-btn-secondary" onClick={turnOff} disabled={pending}>
            Turn off here
          </button>
        </div>
      )}
      {message && (
        <p role="status" className="text-sm text-muted">
          {message}
        </p>
      )}
    </div>
  )
}
