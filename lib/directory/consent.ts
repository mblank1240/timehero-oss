/**
 * Registering the organization's Microsoft tenant, by administrator consent.
 *
 * An administrator of this deployment is sent to Microsoft's admin-consent
 * page, where an administrator of the tenant grants the app read access to
 * its directory (and mail, if Graph sends it). Microsoft redirects back with
 * the tenant id. The callback then reads the tenant's verified domains as the
 * app itself — which only succeeds if consent really was granted there — and
 * records the connection.
 */

import { timingSafeEqual } from 'node:crypto'

import { env, MULTI_TENANT_ISSUERS, appUrl, entraIssuerTenant } from '@/lib/env'

export const CONSENT_STATE_COOKIE = 'th_ms_consent'
export const CONSENT_CALLBACK_PATH = '/api/directory/microsoft/callback'

export function adminConsentUrl(state: string): string {
  const issuer = entraIssuerTenant()
  const tenant = issuer && !MULTI_TENANT_ISSUERS.includes(issuer) ? issuer : 'organizations'
  const url = new URL(`https://login.microsoftonline.com/${tenant}/v2.0/adminconsent`)
  url.searchParams.set('client_id', env.AUTH_MICROSOFT_ENTRA_ID_ID ?? '')
  url.searchParams.set('scope', 'https://graph.microsoft.com/.default')
  url.searchParams.set('redirect_uri', `${appUrl()}${CONSENT_CALLBACK_PATH}`)
  url.searchParams.set('state', state)
  return url.toString()
}

export function statesMatch(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * A single-tenant app signs people in from one tenant only, so a directory
 * from any other could never be used to sign anyone in. Null when fine.
 */
export function tenantMismatch(tenant: string): string | null {
  const issuer = entraIssuerTenant()
  if (!issuer || MULTI_TENANT_ISSUERS.includes(issuer)) return null
  // A single-tenant issuer may name the tenant by id or by a domain.
  if (/^[0-9a-f-]{36}$/i.test(issuer) && issuer !== tenant.toLowerCase()) {
    return `This deployment signs people in from tenant ${issuer}, but consent was granted in ${tenant}.`
  }
  return null
}
