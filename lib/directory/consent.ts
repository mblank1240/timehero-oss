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

const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A single-tenant app signs people in from one tenant only, so a directory
 * from any other could never be used to sign anyone in. Null when fine.
 *
 * The issuer may name its tenant by id or by one of its domains. Microsoft
 * answers consent with the id, so a domain can only be confirmed against the
 * tenant's verified domains, when the caller has read them; until then a
 * domain-form issuer is refused rather than assumed to match.
 */
export function tenantMismatch(
  tenant: string,
  opts: { domains?: readonly string[]; issuer?: string | null } = {},
): string | null {
  const issuer = opts.issuer !== undefined ? opts.issuer : entraIssuerTenant()
  if (!issuer || MULTI_TENANT_ISSUERS.includes(issuer)) return null
  const mismatch = `This deployment signs people in from tenant ${issuer}, but consent was granted in ${tenant}.`
  if (TENANT_ID.test(issuer)) return issuer === tenant.toLowerCase() ? null : mismatch
  if (!opts.domains) {
    return `This deployment names its Microsoft tenant as ${issuer}, which cannot be checked against the tenant that granted consent (${tenant}). Set AUTH_MICROSOFT_ENTRA_ID_ISSUER to use the tenant id instead.`
  }
  return opts.domains.some((d) => d.toLowerCase() === issuer) ? null : mismatch
}
