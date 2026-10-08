/**
 * Who a Microsoft or Google sign-in is, decided as a pure function.
 *
 * The rules, in order:
 *
 * 1. **The organization's own accounts only.** With a directory registered,
 *    a Microsoft sign-in must come from its tenant, and a Google one from
 *    one of its Workspace domains. Anything else is refused outright.
 *    Without one, a multi-tenant Microsoft app (`common`/`organizations`)
 *    is refused too: any Microsoft account anywhere could claim any email
 *    address, and linking by it would let a stranger sign in as an employee
 *    (the "nOAuth" class of mistake). So is Google: a personal Google
 *    account can be made on any address, including a work one, and would
 *    outlive the person's job there. Without a Workspace registered, only a
 *    Google account bound earlier gets in.
 * 2. **A bound account is its employee.** Matched on the provider's stable
 *    id, so a renamed mailbox still gets in.
 * 3. **Otherwise link by email** — only an address the provider vouches for,
 *    and with a directory registered, only one in its domains. Google links
 *    only with a Workspace registered (rule 1).
 * 4. **Otherwise create the employee** from a registered Microsoft directory,
 *    when it allows that. The service confirms with the directory that the
 *    account exists and is enabled before doing so.
 *
 * Whether the employee may sign in at all (active, not terminated) is
 * checked afterwards, by `resolveEmployeeForSignIn`, as for every route in —
 * and `disabledInDirectory`, below.
 */

export type ExternalProvider = 'MICROSOFT' | 'GOOGLE'

export type ExternalSignIn = {
  provider: ExternalProvider
  subject: string
  /** Microsoft: the `tid` claim. Google: the `hd` claim, absent for a personal account. */
  tenant: string | null
  email: string | null
  /** Whether the provider vouches for the address. */
  emailVerified: boolean
}

export type Connection = {
  tenantId: string
  domains: string[]
  autoProvision: boolean
} | null

export type LinkDecision =
  | { kind: 'EXISTING'; employeeId: string }
  | { kind: 'LINK'; employeeId: string }
  | { kind: 'PROVISION'; email: string }
  | {
      kind: 'DENY'
      reason: 'WRONG_TENANT' | 'UNTRUSTED_TENANT' | 'NOT_LINKED'
    }

/**
 * True when the directory sync has seen one of the employee's linked accounts
 * disabled. The sync only flags such an employee for review — leaving is an
 * HR decision — but nobody signs in by any route meanwhile: a disabled
 * directory account is usually someone who has left, and an emailed link or a
 * Google account must not outlast it. Unlinking the account (the employee's
 * page) lets them back in; a later sync that sees it enabled again does too.
 */
export function disabledInDirectory(
  identities: readonly { directoryAccountEnabled: boolean | null }[],
): boolean {
  return identities.some((i) => i.directoryAccountEnabled === false)
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase()
}

export function decideExternalSignIn(args: {
  signIn: ExternalSignIn
  connection: Connection
  /** True when the Entra issuer is `common`, `organizations` or `consumers`. */
  issuerIsMultiTenant: boolean
  /** The employee already bound to `(provider, subject)`, if any. */
  boundEmployeeId: string | null
  /** The employee whose email equals the sign-in's, if any. */
  emailEmployeeId: string | null
}): LinkDecision {
  const { signIn, connection } = args
  const email = signIn.email?.trim().toLowerCase() ?? null
  const domains = connection?.domains.map((d) => d.toLowerCase()) ?? []

  if (connection) {
    const ours =
      signIn.provider === 'MICROSOFT'
        ? signIn.tenant?.toLowerCase() === connection.tenantId.toLowerCase()
        : signIn.tenant !== null && domains.includes(signIn.tenant.toLowerCase())
    if (!ours) return { kind: 'DENY', reason: 'WRONG_TENANT' }
  } else if (
    !args.boundEmployeeId &&
    (signIn.provider === 'GOOGLE' || args.issuerIsMultiTenant)
  ) {
    return { kind: 'DENY', reason: 'UNTRUSTED_TENANT' }
  }

  if (args.boundEmployeeId) return { kind: 'EXISTING', employeeId: args.boundEmployeeId }

  const linkable =
    email !== null && signIn.emailVerified && (!connection || domains.includes(emailDomain(email)))
  if (!linkable) return { kind: 'DENY', reason: 'NOT_LINKED' }

  if (args.emailEmployeeId) return { kind: 'LINK', employeeId: args.emailEmployeeId }

  if (connection?.autoProvision && signIn.provider === 'MICROSOFT') {
    return { kind: 'PROVISION', email }
  }
  return { kind: 'DENY', reason: 'NOT_LINKED' }
}
