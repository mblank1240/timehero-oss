/**
 * Microsoft Graph, as the app itself (client credentials) — for reading the
 * organization's directory and sending mail from a shared mailbox. Uses the
 * same Entra app registration as sign-in, which needs the application
 * permissions `User.Read.All` (directory) and `Mail.Send` (mail), granted by
 * an administrator's consent. See docs/ENTRA-SETUP.md.
 *
 * Plain `fetch`: the three calls this makes do not justify the Graph SDK.
 */

import type { DirectoryUser } from '@/lib/directory/plan'
import { env } from '@/lib/env'

const GRAPH = 'https://graph.microsoft.com/v1.0'

/** How long one call to Microsoft may take before it is abandoned. */
const TIMEOUT_MS = 30_000

export class GraphError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'GraphError'
  }
}

const tokens = new Map<string, { value: string; expiresAt: number }>()

/** An app-only token for `tenantId`, cached until a minute before it expires. */
export async function appToken(tenantId: string): Promise<string> {
  const cached = tokens.get(tenantId)
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value

  if (!env.AUTH_MICROSOFT_ENTRA_ID_ID || !env.AUTH_MICROSOFT_ENTRA_ID_SECRET) {
    throw new GraphError('Microsoft Entra ID is not configured.')
  }

  const response = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.AUTH_MICROSOFT_ENTRA_ID_ID,
        client_secret: env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }),
    },
  )
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string
    expires_in?: number
    error_description?: string
  }
  if (!response.ok || !body.access_token) {
    throw new GraphError(
      `Could not get a Microsoft Graph token: ${body.error_description ?? response.statusText}`,
      response.status,
    )
  }
  tokens.set(tenantId, {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  })
  return body.access_token
}

async function graph<T>(tenantId: string, path: string, init: RequestInit = {}): Promise<T> {
  const url = path.startsWith('https://') ? path : `${GRAPH}${path}`
  // Graph's paging links are absolute; never send the token anywhere else.
  if (!url.startsWith(`${GRAPH}/`)) throw new GraphError(`Refusing to call ${url}`)

  const response = await fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${await appToken(tenantId)}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })
  if (response.status === 202 || response.status === 204) return undefined as T
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: { message?: string }
  }
  if (!response.ok) {
    throw new GraphError(
      body.error?.message ?? `Graph returned ${response.status}`,
      response.status,
    )
  }
  return body
}

export type { DirectoryUser }

const USER_FIELDS =
  'id,displayName,givenName,surname,mail,userPrincipalName,accountEnabled,userType,employeeHireDate'

/** A user as Graph returns them, with the manager expanded to its id. */
type GraphUser = Omit<DirectoryUser, 'managerId'> & { manager?: { id: string } | null }

function fromGraph({ manager, ...user }: GraphUser): DirectoryUser {
  return { ...user, managerId: manager?.id ?? null }
}

// The manager needs nothing beyond User.Read.All, which the sync already has.
const EXPAND_MANAGER = '$expand=manager($select=id)'

export async function listUsers(tenantId: string): Promise<DirectoryUser[]> {
  const users: DirectoryUser[] = []
  let next: string | undefined = `/users?$select=${USER_FIELDS}&${EXPAND_MANAGER}&$top=999`
  while (next) {
    const page: { value: GraphUser[]; '@odata.nextLink'?: string } = await graph(tenantId, next)
    users.push(...page.value.map(fromGraph))
    next = page['@odata.nextLink']
  }
  return users
}

export async function getUser(tenantId: string, id: string): Promise<DirectoryUser | null> {
  try {
    return fromGraph(
      await graph<GraphUser>(
        tenantId,
        `/users/${encodeURIComponent(id)}?$select=${USER_FIELDS}&${EXPAND_MANAGER}`,
      ),
    )
  } catch (error) {
    if (error instanceof GraphError && error.status === 404) return null
    throw error
  }
}

/** The tenant's verified domains — which addresses are the organization's own. */
export async function verifiedDomains(tenantId: string): Promise<string[]> {
  const org: { value: { verifiedDomains: { name: string }[] }[] } = await graph(
    tenantId,
    '/organization',
  )
  return [...new Set(org.value.flatMap((o) => o.verifiedDomains.map((d) => d.name.toLowerCase())))]
}

export async function sendMailAs(
  tenantId: string,
  from: string,
  message: { to: string; subject: string; text: string },
): Promise<void> {
  await graph(tenantId, `/users/${encodeURIComponent(from)}/sendMail`, {
    method: 'POST',
    body: JSON.stringify({
      message: {
        subject: message.subject,
        body: { contentType: 'Text', content: message.text },
        toRecipients: [{ emailAddress: { address: message.to } }],
      },
      saveToSentItems: false,
    }),
  })
}
