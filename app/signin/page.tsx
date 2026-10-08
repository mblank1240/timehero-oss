import { AuthError } from 'next-auth'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { signIn } from '@/lib/auth'
import { getCurrentUser } from '@/lib/authz'
import { env, isEntraConfigured, isGoogleConfigured } from '@/lib/env'
import { emailLinksAvailable, requestSignInLink, signInLinkInput } from '@/lib/sign-in-links'

export const metadata = { title: 'Sign in · TimeHero' }

/**
 * Why a sign-in was refused. The Microsoft and Google codes come from
 * `resolveExternalSignIn`; the rest are Auth.js's own.
 */
const MESSAGES: Record<string, string> = {
  AccessDenied:
    'Your account signed in successfully, but it is not linked to an active employee record. Please contact your administrator.',
  NotLinked:
    'Your account signed in successfully, but it is not linked to an employee record. Please contact your administrator.',
  WrongTenant:
    'That account is not from your organization. Sign in with the account your organization gave you.',
  UntrustedTenant:
    'This Microsoft account cannot be matched to an employee until your administrator connects your organization’s Microsoft 365.',
  Inactive: 'Your employee record is not active. Please contact your administrator.',
  DirectoryUnavailable:
    'Your organization’s directory could not be reached to set up your account. Please try again shortly.',
  CredentialsSignin:
    'No active employee has that email address. Check the seeded accounts in prisma/seed.ts.',
  Configuration:
    'Sign-in is not configured correctly. Please contact your administrator.',
  Verification: 'That sign-in link has expired. Please try again.',
  BadEmail: 'Enter your email address.',
  LinkInvalid:
    'That sign-in link has expired or has already been used. Ask for a new one below.',
}

/**
 * On success `signIn` throws a redirect, which must be allowed to propagate.
 * On failure the Credentials provider throws `CredentialsSignin` instead of
 * redirecting the way an OAuth provider does, so without this the page would
 * surface a raw error rather than telling the person what went wrong.
 */
async function signInOrShowError(
  provider: string,
  options: Record<string, string>,
): Promise<never> {
  try {
    await signIn(provider, options)
  } catch (error) {
    if (error instanceof AuthError) {
      redirect(`/signin?error=${encodeURIComponent(error.type)}`)
    }
    throw error
  }
  // `signIn` always either redirects or throws.
  throw new Error('Unreachable: signIn returned without redirecting.')
}

export default async function SignInPage({ searchParams }: PageProps<'/signin'>) {
  if (await getCurrentUser()) redirect('/')

  const params = await searchParams
  const emailLinks = await emailLinksAvailable()
  const sent = params.sent === '1'
  const limited = params.limited === '1'
  const errorCode = typeof params.error === 'string' ? params.error : undefined
  const message = errorCode
    ? (MESSAGES[errorCode] ?? 'Sign-in failed. Please try again or contact your administrator.')
    : undefined

  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-semibold">Sign in to TimeHero</h1>
      <p className="mt-2 text-sm text-muted">
        Use the account your organization gave you, or have a sign-in link emailed to you.
      </p>

      {message && (
        <p role="alert" className="th-error mt-6">
          {message}
        </p>
      )}

      {sent && (
        <p role="status" className="th-card mt-6 p-3 text-sm">
          If that address belongs to an account, a sign-in link is on its way. It works once, for
          the next few minutes.
        </p>
      )}
      {limited && (
        <p role="alert" className="th-error mt-6">
          Too many sign-in links have been asked for. Please wait a while and try again.
        </p>
      )}

      {(isEntraConfigured || isGoogleConfigured) && (
        <div className="mt-6 space-y-3">
          {isEntraConfigured && (
            <form
              action={async () => {
                'use server'
                await signInOrShowError('microsoft-entra-id', { redirectTo: '/' })
              }}
            >
              <button type="submit" className="th-btn w-full">
                Sign in with Microsoft
              </button>
            </form>
          )}
          {isGoogleConfigured && (
            <form
              action={async () => {
                'use server'
                await signInOrShowError('google', { redirectTo: '/' })
              }}
            >
              <button type="submit" className="th-btn w-full">
                Sign in with Google
              </button>
            </form>
          )}
        </div>
      )}

      {emailLinks && (
        <form
          className="mt-6 space-y-3"
          action={async (formData: FormData) => {
            'use server'
            const parsed = signInLinkInput.safeParse({ email: formData.get('email') })
            if (!parsed.success) redirect('/signin?error=BadEmail')
            const forwarded = (await headers()).get('x-forwarded-for')
            const outcome = await requestSignInLink({
              email: parsed.data.email,
              ipAddress: forwarded?.split(',')[0]?.trim() || null,
            })
            redirect(
              outcome === 'RATE_LIMITED'
                ? '/signin?limited=1'
                : outcome === 'UNAVAILABLE'
                  ? '/signin'
                  : '/signin?sent=1',
            )
          }}
        >
          {(isEntraConfigured || isGoogleConfigured) && (
            <p className="text-center text-xs uppercase tracking-wide text-muted">or</p>
          )}
          <div>
            <label htmlFor="link-email" className="th-label">
              Email me a sign-in link
            </label>
            <input
              id="link-email"
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="you@example.org"
              className="th-input"
            />
          </div>
          <button type="submit" className="th-btn-secondary w-full">
            Send link
          </button>
        </form>
      )}

      {env.DEV_AUTH_BYPASS && (
        <div className="th-card mt-8 p-4">
          <h2 className="text-sm font-semibold">Development sign-in</h2>
          <p className="mt-1 text-xs text-muted">
            Signs in as any employee without checking anything. It cannot run in production — the
            app refuses to start with it enabled.
          </p>
          <form
            className="mt-3 space-y-3"
            action={async (formData: FormData) => {
              'use server'
              await signInOrShowError('dev-bypass', {
                email: String(formData.get('email') ?? ''),
                redirectTo: '/',
              })
            }}
          >
            <div>
              <label htmlFor="email" className="th-label">
                Employee email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="off"
                placeholder="you@example.test"
                className="th-input"
              />
            </div>
            <button type="submit" className="th-btn-secondary w-full">
              Continue
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
