/**
 * Sending mail, whatever carries it.
 *
 * One function for the rest of the app; the transport is configuration
 * (`MAIL_TRANSPORT`). A church on Microsoft 365 sends through Graph from a
 * shared mailbox; anyone else uses SMTP, which every mail provider speaks.
 * Development writes each message to a file instead, which is also how the
 * end-to-end tests read a sign-in link; lib/env.ts refuses that, and
 * `console`, in production.
 *
 * Who it is from is not configuration but an administrator's setting
 * (`OrgSettings.mailFromAddress`): an organization gets email only from an
 * address it chose. With none set, nothing is sent at all — notifications go
 * by push, and emailed sign-in links are not offered.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { env, entraIssuerTenant } from '@/lib/env'

export type Mail = { to: string; subject: string; text: string }

/** How long an SMTP server may take to connect, greet, or answer a command. */
const SMTP_TIMEOUT_MS = 30_000

export class MailNotConfiguredError extends Error {
  constructor(what = 'Outgoing mail is not configured (MAIL_TRANSPORT).') {
    super(what)
    this.name = 'MailNotConfiguredError'
  }
}

/** Which transport is in force. Outside production, an unset one means `file`. */
export function mailTransport(): NonNullable<typeof env.MAIL_TRANSPORT> | null {
  if (env.MAIL_TRANSPORT) return env.MAIL_TRANSPORT
  return env.NODE_ENV === 'production' ? null : 'file'
}

/**
 * The address mail is sent from, or null when this organization sends none:
 * no address set, or no transport to send it with.
 */
export async function sendingAddress(): Promise<string | null> {
  if (!mailTransport()) return null
  const { db } = await import('@/lib/db')
  const org = await db.orgSettings.findUnique({
    where: { id: 1 },
    select: { mailFromAddress: true },
  })
  return org?.mailFromAddress ?? null
}

export async function sendMail(mail: Mail): Promise<void> {
  const from = await sendingAddress()
  if (!from) {
    throw new MailNotConfiguredError(
      mailTransport()
        ? 'No sending address is set (Administration → Notifications).'
        : undefined,
    )
  }

  switch (mailTransport()) {
    case 'smtp': {
      const { createTransport } = await import('nodemailer')
      // The URL carries the server and credentials; the timeouts keep a mail
      // server that stops answering from holding up the notification run.
      await createTransport({
        url: env.SMTP_URL,
        connectionTimeout: SMTP_TIMEOUT_MS,
        greetingTimeout: SMTP_TIMEOUT_MS,
        socketTimeout: SMTP_TIMEOUT_MS,
      }).sendMail({
        from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
      })
      return
    }
    case 'graph': {
      const { sendMailAs } = await import('@/lib/microsoft/graph')
      const tenant = await graphTenant()
      await sendMailAs(tenant, from, mail)
      return
    }
    case 'file': {
      const dir = path.resolve(env.MAIL_FILE_DIR)
      await mkdir(dir, { recursive: true })
      const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
      await writeFile(
        path.join(dir, name),
        JSON.stringify({ from, ...mail, sentAt: new Date() }, null, 2),
      )
      return
    }
    case 'console':
      console.info(`[mail] from ${from} to ${mail.to}: ${mail.subject}\n${mail.text}`)
      return
    default:
      throw new MailNotConfiguredError()
  }
}

/** The tenant Graph sends from: the connected directory's, else the sign-in issuer's. */
async function graphTenant(): Promise<string> {
  const { db } = await import('@/lib/db')
  const connection = await db.directoryConnection.findUnique({
    where: { provider: 'MICROSOFT' },
    select: { tenantId: true },
  })
  const tenant = connection?.tenantId ?? entraIssuerTenant()
  if (!tenant) throw new MailNotConfiguredError()
  return tenant
}
