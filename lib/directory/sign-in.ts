/**
 * Resolving a Microsoft or Google sign-in to an employee: the database half
 * of `decideExternalSignIn`.
 */

import { db } from '@/lib/db'
import { MULTI_TENANT_ISSUERS, entraIssuerTenant } from '@/lib/env'
import { resolveEmployeeForSignIn } from '@/lib/sign-in'

import { decideExternalSignIn, type ExternalSignIn } from './link'
import type { Directory } from './sources'
import { provisionFromDirectory } from './sync'

/** The codes the sign-in page explains. */
export type SignInRefusal =
  'WrongTenant' | 'UntrustedTenant' | 'NotLinked' | 'Inactive' | 'DirectoryUnavailable'

export async function resolveExternalSignIn(
  signIn: ExternalSignIn,
  opts: { directory?: Directory; now?: Date } = {},
): Promise<{ ok: true; employeeId: string } | { ok: false; refusal: SignInRefusal }> {
  const now = opts.now ?? new Date()
  const email = signIn.email?.trim().toLowerCase() ?? null

  const connection = await db.directoryConnection.findUnique({
    where: { provider: signIn.provider },
    select: {
      provider: true,
      tenantId: true,
      domains: true,
      autoProvision: true,
    },
  })
  const bound = await db.identity.findUnique({
    where: {
      provider_subject: { provider: signIn.provider, subject: signIn.subject },
    },
    select: { employeeId: true },
  })
  const byEmail = email
    ? await db.employee.findUnique({ where: { email }, select: { id: true } })
    : null

  const issuerTenant = entraIssuerTenant()
  const decision = decideExternalSignIn({
    signIn: { ...signIn, email },
    connection,
    issuerIsMultiTenant: issuerTenant !== null && MULTI_TENANT_ISSUERS.includes(issuerTenant),
    boundEmployeeId: bound?.employeeId ?? null,
    emailEmployeeId: byEmail?.id ?? null,
  })

  let employeeId: string
  switch (decision.kind) {
    case 'DENY':
      return {
        ok: false,
        refusal:
          decision.reason === 'WRONG_TENANT'
            ? 'WrongTenant'
            : decision.reason === 'UNTRUSTED_TENANT'
              ? 'UntrustedTenant'
              : 'NotLinked',
      }
    case 'PROVISION': {
      try {
        const created = await provisionFromDirectory({
          connection: connection!,
          subject: signIn.subject,
          directory: opts.directory,
          now,
        })
        if (!created) return { ok: false, refusal: 'NotLinked' }
        employeeId = created
      } catch (error) {
        console.error('Could not read the directory at sign-in', error)
        return { ok: false, refusal: 'DirectoryUnavailable' }
      }
      break
    }
    case 'LINK':
      employeeId = decision.employeeId
      await db.identity.create({
        data: {
          employeeId,
          provider: signIn.provider,
          subject: signIn.subject,
          tenant: signIn.tenant,
          email,
          lastUsedAt: now,
        },
      })
      break
    case 'EXISTING':
      employeeId = decision.employeeId
      await db.identity.update({
        where: {
          provider_subject: {
            provider: signIn.provider,
            subject: signIn.subject,
          },
        },
        data: { lastUsedAt: now, tenant: signIn.tenant, email },
      })
      break
  }

  const employee = await db.employee.findUniqueOrThrow({
    where: { id: employeeId },
    select: { isActive: true, terminationDate: true },
  })
  if (!resolveEmployeeForSignIn(employee, now).ok) return { ok: false, refusal: 'Inactive' }
  return { ok: true, employeeId }
}
