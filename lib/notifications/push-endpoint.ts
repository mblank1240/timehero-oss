/**
 * Which push endpoints the server will send to.
 *
 * A subscription's endpoint comes from the browser, which means from whoever
 * is signed in, and the server POSTs to it. Left open, that is a request the
 * server makes to any address it can reach — its own network included — and
 * "send a test" says whether the address answered. So only the vendors'
 * push services are accepted: on https, on the default port, by name.
 */

/** Hosts a push service answers on exactly. */
const EXACT_HOSTS = new Set([
  'fcm.googleapis.com', // Chrome, Edge on Android, Opera, Brave, Samsung Internet
  'updates.push.services.mozilla.com', // Firefox
  'web.push.apple.com', // Safari
])

/** Push services that hand out per-region hosts under one domain. */
const HOST_SUFFIXES = [
  '.push.services.mozilla.com', // Firefox
  '.notify.windows.com', // Edge on Windows (WNS)
  '.push.apple.com', // Safari
]

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/** Whether `endpoint` is a Web Push service URL the server may POST to. */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  // The URL parser drops a default `:443`; anything left is a different port.
  if (url.port !== '') return false
  if (url.username !== '' || url.password !== '') return false

  // Parsing normalizes `0x7f.1` and friends to dotted IPv4; IPv6 keeps brackets.
  const host = url.hostname.toLowerCase()
  if (IPV4.test(host) || host.includes(':') || host.startsWith('[')) return false

  return EXACT_HOSTS.has(host) || HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
}
