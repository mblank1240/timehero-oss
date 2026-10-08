import { randomBytes } from 'node:crypto'

import { NextResponse } from 'next/server'

import { ForbiddenError, requireAdminOrThrow } from '@/lib/authz'
import { CONSENT_STATE_COOKIE, adminConsentUrl } from '@/lib/directory/consent'
import { env, isEntraConfigured } from '@/lib/env'

/**
 * Starts registering the organization's Microsoft tenant: sends an
 * administrator to Microsoft's admin-consent page. A route handler because
 * it is an OAuth redirect, which a Server Action cannot be.
 */
export async function GET() {
  try {
    await requireAdminOrThrow()
  } catch (error) {
    if (error instanceof ForbiddenError) return new Response(error.message, { status: 403 })
    throw error
  }
  if (!isEntraConfigured) {
    return new Response('Microsoft Entra ID is not configured for this deployment.', {
      status: 400,
    })
  }

  const state = randomBytes(24).toString('base64url')
  const response = NextResponse.redirect(adminConsentUrl(state))
  response.cookies.set(CONSENT_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/api/directory/microsoft',
    maxAge: 600,
  })
  return response
}
