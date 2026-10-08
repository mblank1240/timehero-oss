import { AuthError } from 'next-auth'
import { redirect } from 'next/navigation'

import { signIn } from '@/lib/auth'
import { env } from '@/lib/env'

export const metadata = { title: 'Sign in · TimeHero' }

/**
 * Where an emailed sign-in link lands. Deliberately a button, not an
 * automatic sign-in: mail scanners open links in messages, and a GET that
 * spent the token would sign the scanner in and leave the person's link dead.
 */
export default async function SignInLinkPage({ searchParams }: PageProps<'/signin/link'>) {
  if (!env.AUTH_EMAIL_LINKS) redirect('/signin')
  const { token } = await searchParams
  if (typeof token !== 'string' || !token) redirect('/signin?error=LinkInvalid')

  return (
    <div className="mx-auto max-w-md space-y-6">
      <h1 className="text-2xl font-semibold">Sign in to TimeHero</h1>
      <form
        action={async () => {
          'use server'
          try {
            await signIn('email-link', { token, redirectTo: '/' })
          } catch (error) {
            if (error instanceof AuthError) redirect('/signin?error=LinkInvalid')
            throw error
          }
        }}
      >
        <button type="submit" className="th-btn w-full">
          Continue to TimeHero
        </button>
      </form>
      <p className="text-sm text-muted">The link works once. If it has expired, ask for a new one.</p>
    </div>
  )
}
