import NextAuth, { type DefaultSession } from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import Google from 'next-auth/providers/google'
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id'

import { db } from './db'
import { resolveExternalSignIn } from './directory/sign-in'
import { env, isEntraConfigured, isGoogleConfigured } from './env'
import { resolveEmployeeForSignIn } from './sign-in'
import { consumeSignInLink } from './sign-in-links'

declare module 'next-auth' {
  interface Session {
    user: {
      employeeId: string
    } & DefaultSession['user']
  }
}

/**
 * Every way in ends at an existing employee — or one created from the
 * organization's own directory. Nobody registers themselves.
 * docs/AUTH-PLAN.md has the design.
 */
const providers = []

if (isEntraConfigured) {
  providers.push(
    MicrosoftEntraID({
      clientId: env.AUTH_MICROSOFT_ENTRA_ID_ID!,
      clientSecret: env.AUTH_MICROSOFT_ENTRA_ID_SECRET!,
      issuer: env.AUTH_MICROSOFT_ENTRA_ID_ISSUER!,
    }),
  )
}

if (isGoogleConfigured) {
  providers.push(
    Google({
      clientId: env.AUTH_GOOGLE_ID!,
      clientSecret: env.AUTH_GOOGLE_SECRET!,
    }),
  )
}

if (env.AUTH_EMAIL_LINKS) {
  // The emailed link's token, spent once. `lib/sign-in-links.ts` decides.
  providers.push(
    Credentials({
      id: 'email-link',
      name: 'Emailed link',
      credentials: { token: { label: 'Token', type: 'text' } },
      async authorize(credentials) {
        const employee = await consumeSignInLink(String(credentials?.token ?? ''))
        if (!employee) return null
        return {
          id: employee.id,
          email: employee.email,
          name: `${employee.firstName} ${employee.lastName}`,
        }
      },
    }),
  )
}

// Development only. `lib/env.ts` refuses to boot if this is enabled in
// production, so this provider cannot reach a deployed environment.
if (env.DEV_AUTH_BYPASS) {
  providers.push(
    Credentials({
      id: 'dev-bypass',
      name: 'Development sign-in',
      credentials: { email: { label: 'Email', type: 'email' } },
      async authorize(credentials) {
        const email = String(credentials?.email ?? '')
          .trim()
          .toLowerCase()
        if (!email) return null

        const employee = await db.employee.findUnique({ where: { email } })
        if (!employee) return null

        const resolved = resolveEmployeeForSignIn(employee, new Date())
        if (!resolved.ok) return null

        return {
          id: employee.id,
          email: employee.email,
          name: `${employee.firstName} ${employee.lastName}`,
        }
      },
    }),
  )
}

type MicrosoftProfile = {
  oid?: string
  tid?: string
  email?: string
  preferred_username?: string
}
type GoogleProfile = {
  sub?: string
  email?: string
  email_verified?: boolean
  hd?: string
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  session: { strategy: 'jwt' },
  pages: {
    signIn: '/signin',
    error: '/signin',
  },
  callbacks: {
    /**
     * The access gate for Microsoft and Google. The credentials providers
     * have already decided in `authorize`. A refusal returns to the sign-in
     * page with a code it explains.
     */
    async signIn({ user, account, profile }) {
      if (account?.provider === 'dev-bypass' || account?.provider === 'email-link') return true

      let resolved: Awaited<ReturnType<typeof resolveExternalSignIn>>
      if (account?.provider === 'microsoft-entra-id') {
        const p = (profile ?? {}) as MicrosoftProfile
        if (!p.oid) return '/signin?error=NotLinked'
        resolved = await resolveExternalSignIn({
          provider: 'MICROSOFT',
          subject: p.oid,
          tenant: p.tid ?? null,
          email: p.email ?? p.preferred_username ?? user.email ?? null,
          // The tenant vouches for its own addresses; which tenants are
          // trusted is decided in `decideExternalSignIn`.
          emailVerified: true,
        })
      } else if (account?.provider === 'google') {
        const p = (profile ?? {}) as GoogleProfile
        if (!p.sub) return '/signin?error=NotLinked'
        resolved = await resolveExternalSignIn({
          provider: 'GOOGLE',
          subject: p.sub,
          tenant: p.hd ?? null,
          email: p.email ?? null,
          emailVerified: p.email_verified === true,
        })
      } else {
        return false
      }

      if (!resolved.ok) return `/signin?error=${resolved.refusal}`
      user.id = resolved.employeeId
      return true
    },

    async jwt({ token, user }) {
      if (user?.id) token.employeeId = user.id
      return token
    },

    async session({ session, token }) {
      // Only the employee id is carried in the session. Role is deliberately
      // absent: it is re-read from the database on every authorization check
      // so a revoked admin loses access immediately, not at token expiry.
      session.user.employeeId = token.employeeId as string
      return session
    },
  },
})
