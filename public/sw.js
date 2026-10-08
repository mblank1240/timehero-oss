/*
 * TimeHero's service worker. It does one thing: show Web Push notifications
 * and open the right page when one is clicked. No offline caching — every
 * page needs the server anyway.
 *
 * The payload is what lib/notifications/deliver.ts sends:
 * { title, body, url, tag }.
 */

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }

  event.waitUntil(
    self.registration.showNotification(data.title || 'TimeHero', {
      body: data.body || '',
      tag: data.tag,
      data: { url: data.url || '/notifications' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if (w.url === url && 'focus' in w) return w.focus()
      }
      return self.clients.openWindow(url)
    }),
  )
})
