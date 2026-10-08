/**
 * Passwordless sign-in by emailed link.
 *
 * Someone types their address; if it belongs to an employee who may sign in,
 * a single-use link valid for a short while is mailed to it. Whatever the
 * address, the page says the same thing, so it cannot be used to find out
 * who works here. Only the SHA-256 of a token is stored, so a database leak
 * signs nobody in.
 *
 * The link opens a page with a button rather than signing in on the GET:
 * mail scanners follow links in messages, and would otherwise spend the
 * token before the person ever clicked it.
 *
 * The message is sent after the response (`after()`), so a real address and
 * an unknown one take the same time to answer: waiting on the mail server
 * only for employees would tell a stranger which addresses are real.
 */

import { createHash, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'

import { after } from 'next/server'
import { z } from 'zod'

import { db } from '@/lib/db'
import { disabledInDirectory } from '@/lib/directory/link'
import { appUrl, env } from '@/lib/env'
import { sendMail, sendingAddress } from '@/lib/mail'
import { resolveEmployeeForSignIn } from '@/lib/sign-in'

/**
 * Security parameters, not organization policy (rule 1 is about policy): how
 * long a link lives and how many may be asked for. Short enough that a link
 * sitting in an inbox is soon useless; generous enough for a typo or two.
 */
export const LINK_LIFETIME_MINUTES = 15
export const MAX_REQUESTS_PER_ADDRESS_PER_HOUR = 5
export const MAX_REQUESTS_PER_IP_PER_HOUR = 20
/**
 * Links mailed per hour across everyone — a ceiling on what a flood spread
 * over many addresses and connections can make the organization's mailbox
 * send. Far above what a staff signing in on a Monday morning needs.
 */
export const MAX_LINKS_SENT_PER_HOUR = 100

const HOUR_MS = 60 * 60 * 1000

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * The client's address, for the per-connection limit, from `X-Forwarded-For`.
 * Each proxy appends the address it was reached from, so only the right-most
 * entry — written by the proxy in front of the app (App Service, or the one in
 * front of a container) — is not the client's to choose; the entries before
 * it are whatever the request arrived with. App Service writes it with a
 * port, which is dropped. Anything that is not an IP address gives null, and
 * every request without one shares a single limit.
 */
export function clientIpFrom(forwardedFor: string | null): string | null {
  const last = forwardedFor?.split(',').at(-1)?.trim()
  if (!last) return null
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(last)
  const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(last)
  const address = bracketed?.[1] ?? ipv4WithPort?.[1] ?? last
  return isIP(address) ? address.toLowerCase() : null
}

export const signInLinkInput = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('Enter your email address.')),
})

/**
 * Whether "Email me a sign-in link" is offered: switched on for the
 * deployment, and the organization has an address to send from. An
 * administrator clearing the address takes the option away at once.
 */
export async function emailLinksAvailable(): Promise<boolean> {
  return env.AUTH_EMAIL_LINKS && (await sendingAddress()) !== null
}

export type LinkRequestOutcome =
  /** Said to everyone who asked properly, whether or not anything was sent. */
  | 'SENT_IF_KNOWN'
  /** Too many requests for this address, from this connection, or in all. */
  | 'RATE_LIMITED'
  /** Emailed links are not offered: no sending address, or switched off. */
  | 'UNAVAILABLE'

/**
 * Asks for a link. Every request is recorded — the rate limits count them —
 * and a token is made only for an employee who may sign in. The limits count
 * requests whether or not the address exists, so being told about one gives
 * nothing away. Requests with no client address (`ipAddress` null) share one
 * per-connection limit rather than escaping it.
 *
 * `defer` runs the send once the response has gone; it is Next's `after()`,
 * and tests pass their own to wait for the message.
 */
export async function requestSignInLink(args: {
  email: string
  ipAddress: string | null
  now?: Date
  defer?: (task: () => Promise<void>) => void
}): Promise<LinkRequestOutcome> {
  if (!(await emailLinksAvailable())) return 'UNAVAILABLE'

  const now = args.now ?? new Date()
  const email = args.email.trim().toLowerCase()
  const since = new Date(now.getTime() - HOUR_MS)

  const [byAddress, byIp, sent] = await Promise.all([
    db.signInLinkRequest.count({ where: { email, createdAt: { gte: since } } }),
    db.signInLinkRequest.count({
      where: { ipAddress: args.ipAddress, createdAt: { gte: since } },
    }),
    db.signInLinkRequest.count({
      where: { tokenHash: { not: null }, createdAt: { gte: since } },
    }),
  ])
  if (
    byAddress >= MAX_REQUESTS_PER_ADDRESS_PER_HOUR ||
    byIp >= MAX_REQUESTS_PER_IP_PER_HOUR ||
    sent >= MAX_LINKS_SENT_PER_HOUR
  ) {
    return 'RATE_LIMITED'
  }

  const employee = await db.employee.findUnique({
    where: { email },
    select: {
      id: true,
      firstName: true,
      isActive: true,
      terminationDate: true,
      identities: { select: { directoryAccountEnabled: true } },
    },
  })
  const eligible =
    employee &&
    resolveEmployeeForSignIn(employee, now).ok &&
    !disabledInDirectory(employee.identities)

  if (!eligible) {
    await db.signInLinkRequest.create({
      data: { email, ipAddress: args.ipAddress, createdAt: now },
    })
    return 'SENT_IF_KNOWN'
  }

  const token = newToken()
  await db.signInLinkRequest.create({
    data: {
      email,
      ipAddress: args.ipAddress,
      employeeId: employee.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + LINK_LIFETIME_MINUTES * 60_000),
      createdAt: now,
    },
  })

  const link = `${appUrl()}/signin/link?token=${encodeURIComponent(token)}`
  const defer = args.defer ?? after
  defer(async () => {
    try {
      await sendMail({
        to: email,
        subject: 'Your TimeHero sign-in link',
        text: [
          `Hi ${employee.firstName},`,
          '',
          'Use this link to sign in to TimeHero:',
          link,
          '',
          `It works once, for the next ${LINK_LIFETIME_MINUTES} minutes.`,
          'If you did not ask for it, you can ignore this message; nobody can sign in without it.',
        ].join('\n'),
      })
    } catch (error) {
      // Nobody is waiting for the answer, and an error only for real
      // addresses would tell a stranger which ones are real anyway. The
      // operator sees it in the log.
      console.error('Could not send a sign-in link', error)
    }
  })

  return 'SENT_IF_KNOWN'
}

/**
 * Spends a token, once. Returns the employee it signs in, or null for a
 * token that is unknown, used, expired, or belongs to someone who may no
 * longer sign in. The update is conditional on the token being unused, so
 * two clicks racing each other cannot both succeed.
 */
export async function consumeSignInLink(
  token: string,
  now: Date = new Date(),
): Promise<{
  id: string
  email: string
  firstName: string
  lastName: string
} | null> {
  if (!token) return null
  const tokenHash = hashToken(token)

  const spent = await db.signInLinkRequest.updateMany({
    where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  })
  if (spent.count !== 1) return null

  const request = await db.signInLinkRequest.findUnique({
    where: { tokenHash },
    select: {
      employee: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          isActive: true,
          terminationDate: true,
          identities: { select: { directoryAccountEnabled: true } },
        },
      },
    },
  })
  const employee = request?.employee
  if (!employee || !resolveEmployeeForSignIn(employee, now).ok) return null
  if (disabledInDirectory(employee.identities)) return null

  return {
    id: employee.id,
    email: employee.email,
    firstName: employee.firstName,
    lastName: employee.lastName,
  }
}
