import { NextResponse, type NextRequest } from 'next/server'

import { writeAudit } from '@/lib/audit'
import { ForbiddenError, requireAdminOrThrow } from '@/lib/authz'
import { db } from '@/lib/db'
import { CONSENT_STATE_COOKIE, statesMatch, tenantMismatch } from '@/lib/directory/consent'
import { runDirectorySync } from '@/lib/directory/sync'
import { appUrl } from '@/lib/env'
import { runJob } from '@/lib/jobs/runner'
import { verifiedDomains } from '@/lib/microsoft/graph'

/**
 * Where Microsoft's admin-consent page returns. Records the tenant, then runs
 * a first directory sync so staff appear straight away.
 */
export async function GET(request: NextRequest) {
  let actorId: string
  try {
    actorId = (await requireAdminOrThrow()).id
  } catch (error) {
    if (error instanceof ForbiddenError) return new Response(error.message, { status: 403 })
    throw error
  }

  const back = (params: Record<string, string>) => {
    const url = new URL('/admin/directory', appUrl())
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    const response = NextResponse.redirect(url)
    response.cookies.delete({
      name: CONSENT_STATE_COOKIE,
      path: '/api/directory/microsoft',
    })
    return response
  }

  const q = request.nextUrl.searchParams
  // Forged or replayed callbacks stop here.
  if (!statesMatch(q.get('state'), request.cookies.get(CONSENT_STATE_COOKIE)?.value)) {
    return back({
      error: 'The registration could not be verified. Please start again.',
    })
  }
  if (q.get('error')) {
    return back({
      error: q.get('error_description') ?? 'Microsoft did not grant consent.',
    })
  }
  const tenant = q.get('tenant')
  if (!tenant || q.get('admin_consent')?.toLowerCase() !== 'true') {
    return back({ error: 'Microsoft did not grant consent.' })
  }
  let domains: string[]
  try {
    // Succeeds only with consent in that tenant: this is the proof.
    domains = await verifiedDomains(tenant)
  } catch (error) {
    return back({
      error: `Consent was given, but the directory could not be read: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
  if (domains.length === 0) return back({ error: 'That tenant has no verified domains.' })
  // After the read: an issuer named by domain can only be matched against them.
  const mismatch = tenantMismatch(tenant, { domains })
  if (mismatch) return back({ error: mismatch })

  const before = await db.directoryConnection.findUnique({
    where: { provider: 'MICROSOFT' },
  })
  const connection = await db.directoryConnection.upsert({
    where: { provider: 'MICROSOFT' },
    create: {
      provider: 'MICROSOFT',
      tenantId: tenant,
      domains,
      connectedById: actorId,
    },
    update: { tenantId: tenant, domains, connectedById: actorId },
  })
  await writeAudit({
    actorId,
    action: before ? 'directory.reconnect' : 'directory.connect',
    entityType: 'DirectoryConnection',
    entityId: connection.provider,
    before: before ? { tenantId: before.tenantId, domains: before.domains } : undefined,
    after: { tenantId: tenant, domains },
  })

  try {
    const today = new Date()
    await runJob(
      {
        jobName: 'sync-directory',
        periodKey: today.toISOString().slice(0, 10),
      },
      () => runDirectorySync(today, { actorId }),
    )
  } catch {
    // Recorded on the connection and in the run log; the page shows it.
  }
  return back({ connected: 'microsoft' })
}
