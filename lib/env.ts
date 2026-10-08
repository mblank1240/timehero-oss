import { z } from 'zod'

/**
 * Environment contract. Parsed once at module load so a misconfigured deploy
 * fails at boot rather than on the first request that happens to need a value.
 */

/** Treat a blank variable as absent — .env placeholders are often left empty. */
const optionalText = z
  .string()
  .optional()
  .transform((v) => {
    const trimmed = v?.trim()
    return trimmed ? trimmed : undefined
  })

/**
 * `next build` evaluates modules to collect page data, but serves no requests.
 * Requiring real secrets then would mean putting production credentials into
 * CI for no benefit, so the runtime-only checks are skipped during a build.
 * They still run in the deployed process, which is what actually matters.
 */
const isBuildPhase = process.env.NEXT_PHASE === 'phase-production-build'

/**
 * The shortest AUTH_SECRET or JOBS_SECRET production accepts. 32 characters of
 * `openssl rand -base64 33` (or `-hex 32`) is far beyond guessing; anything
 * shorter was typed by hand.
 */
export const MIN_SECRET_LENGTH = 32

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().min(1),
    AUTH_SECRET: z.string().min(1),

    AUTH_MICROSOFT_ENTRA_ID_ID: optionalText,
    AUTH_MICROSOFT_ENTRA_ID_SECRET: optionalText,
    AUTH_MICROSOFT_ENTRA_ID_ISSUER: optionalText,

    AUTH_GOOGLE_ID: optionalText,
    AUTH_GOOGLE_SECRET: optionalText,

    /**
     * Passwordless sign-in by emailed link. Needs outgoing mail and APP_URL,
     * since the link has to point at this deployment.
     */
    AUTH_EMAIL_LINKS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),

    /**
     * Where this deployment is reached, e.g. https://time.example.org. Links
     * in emails and the Microsoft consent redirect are built from it — never
     * from the request's Host header, which the requester controls.
     */
    APP_URL: optionalText.pipe(z.url().optional()),

    /**
     * How mail leaves: `smtp` (SMTP_URL), `graph` (Microsoft Graph, with the
     * Entra app's credentials), or for development `file` (one JSON file per
     * message in MAIL_FILE_DIR) and `console`, both refused in production.
     * The address it is sent from is an administrator's setting, not
     * configuration — see lib/mail.
     */
    // Blank, as .env.example ships it, means unset.
    MAIL_TRANSPORT: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.enum(['smtp', 'graph', 'file', 'console']).optional(),
    ),
    SMTP_URL: optionalText,
    MAIL_FILE_DIR: z.string().default('.mail-outbox'),

    /**
     * Web Push. A VAPID key pair (`npx web-push generate-vapid-keys`) and a
     * contact the push services can reach, `mailto:` or `https:`. Without
     * them push is off and notifications reach the in-app list and email only.
     */
    VAPID_PUBLIC_KEY: optionalText,
    VAPID_PRIVATE_KEY: optionalText,
    VAPID_SUBJECT: optionalText,

    DEV_AUTH_BYPASS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),

    /**
     * Shared secret for the scheduled job routes under /api/jobs. The GitHub
     * Actions workflow sends it; nothing else may run an accrual.
     */
    JOBS_SECRET: optionalText,
  })
  .superRefine((env, ctx) => {
    const entra = [
      env.AUTH_MICROSOFT_ENTRA_ID_ID,
      env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
      env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
    ]
    const configured = entra.filter(Boolean).length

    // Partial Entra config is always a mistake, and a confusing one to debug.
    if (configured > 0 && configured < entra.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_MICROSOFT_ENTRA_ID_ID'],
        message:
          'Entra ID is partially configured. Set all three of ID, SECRET and ISSUER, or none.',
      })
    }

    if (Boolean(env.AUTH_GOOGLE_ID) !== Boolean(env.AUTH_GOOGLE_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_GOOGLE_ID'],
        message: 'Google sign-in is partially configured. Set both ID and SECRET, or neither.',
      })
    }

    if (env.MAIL_TRANSPORT === 'smtp' && !env.SMTP_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_URL'],
        message: 'MAIL_TRANSPORT=smtp needs SMTP_URL.',
      })
    }
    const vapid = [env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT]
    const vapidSet = vapid.filter(Boolean).length
    if (vapidSet > 0 && vapidSet < vapid.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['VAPID_PUBLIC_KEY'],
        message: 'Web Push is partially configured. Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT, or none.',
      })
    }
    if (env.VAPID_SUBJECT && !/^(mailto:|https:)/.test(env.VAPID_SUBJECT)) {
      ctx.addIssue({
        code: 'custom',
        path: ['VAPID_SUBJECT'],
        message: 'VAPID_SUBJECT must be a mailto: or https: address.',
      })
    }
    if (env.MAIL_TRANSPORT === 'graph' && configured < entra.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_TRANSPORT'],
        message: 'MAIL_TRANSPORT=graph sends with the Entra app, so Entra ID must be configured.',
      })
    }

    if (isBuildPhase) return

    if (env.NODE_ENV === 'production') {
      // A link that points nowhere, or mail that never leaves the server, is
      // a sign-in method that silently does not work.
      if (env.AUTH_EMAIL_LINKS && !env.APP_URL) {
        ctx.addIssue({
          code: 'custom',
          path: ['APP_URL'],
          message: 'Emailed sign-in links need APP_URL in production.',
        })
      }
      if (env.AUTH_EMAIL_LINKS && env.MAIL_TRANSPORT !== 'smtp' && env.MAIL_TRANSPORT !== 'graph') {
        ctx.addIssue({
          code: 'custom',
          path: ['MAIL_TRANSPORT'],
          message: 'Emailed sign-in links need MAIL_TRANSPORT=smtp or graph in production.',
        })
      }
      // Both development transports keep every message on the server —
      // sign-in links included — readable by anyone with the logs or disk.
      if (env.MAIL_TRANSPORT === 'file' || env.MAIL_TRANSPORT === 'console') {
        ctx.addIssue({
          code: 'custom',
          path: ['MAIL_TRANSPORT'],
          message: `MAIL_TRANSPORT=${env.MAIL_TRANSPORT} is for development only. Use smtp or graph, or leave it unset to send no mail.`,
        })
      }
      // Links in mail and the Microsoft consent redirect are built from it;
      // without it they would point at localhost.
      if (!env.APP_URL) {
        ctx.addIssue({
          code: 'custom',
          path: ['APP_URL'],
          message: 'APP_URL is required in production: links in mail and sign-in redirects are built from it.',
        })
      }
      // AUTH_SECRET signs every session; JOBS_SECRET lets a caller write to
      // the ledger. Either one guessed is the whole application.
      for (const key of ['AUTH_SECRET', 'JOBS_SECRET'] as const) {
        const value = env[key]
        if (value && value.length < MIN_SECRET_LENGTH) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} must be at least ${MIN_SECRET_LENGTH} characters in production (openssl rand -base64 33).`,
          })
        }
      }
    }

    // The bypass skips Entra entirely and trusts a posted email address. In
    // production that is a total authentication failure, so refuse to start.
    if (env.DEV_AUTH_BYPASS && env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['DEV_AUTH_BYPASS'],
        message: 'DEV_AUTH_BYPASS must not be enabled in production.',
      })
    }

    // The job routes write to the ledger. Without a secret they are either
    // unprotected or unreachable, and in production both are failures: the
    // accrual and rollover jobs have to be able to run.
    if (!env.JOBS_SECRET && env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['JOBS_SECRET'],
        message: 'JOBS_SECRET is required in production so the scheduled jobs can authenticate.',
      })
    }

    // With no provider, no emailed links and no bypass there is no way in.
    if (configured === 0 && !env.AUTH_GOOGLE_ID && !env.AUTH_EMAIL_LINKS && !env.DEV_AUTH_BYPASS) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_EMAIL_LINKS'],
        message:
          'No sign-in method available: configure Microsoft or Google, set AUTH_EMAIL_LINKS=true, or set DEV_AUTH_BYPASS=true outside production.',
      })
    }
  })

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  const detail = parsed.error.issues
    .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n')
  throw new Error(`Invalid environment configuration:\n${detail}`)
}

export const env = parsed.data

export const isEntraConfigured = Boolean(
  env.AUTH_MICROSOFT_ENTRA_ID_ID &&
  env.AUTH_MICROSOFT_ENTRA_ID_SECRET &&
  env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
)

export const isPushConfigured = Boolean(
  env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT,
)

export const isGoogleConfigured = Boolean(env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET)

/** The deployment's own address, for links in mail and OAuth redirects. */
export function appUrl(): string {
  return (env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
}

/**
 * The tenant the Entra issuer names: a GUID or domain for a single-tenant
 * app, or `common` / `organizations` / `consumers` for a multi-tenant one.
 */
export function entraIssuerTenant(
  issuer: string | undefined = env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
): string | null {
  const match = issuer ? /login\.microsoftonline\.com\/([^/]+)/i.exec(issuer) : null
  return match ? match[1].toLowerCase() : null
}

export const MULTI_TENANT_ISSUERS = ['common', 'organizations', 'consumers']
