/**
 * Deciding whether a job request is allowed to run, and what date it runs for.
 *
 * Separate from `runner.ts` because nothing here touches the database: the
 * shared-secret check and the date parsing are the two pieces worth testing
 * without one.
 */

import { timingSafeEqual } from 'node:crypto'

import { addDays, todayIn } from '@/lib/accrual/dates'
import { env } from '@/lib/env'

export type Authorization = { ok: true } | { ok: false; status: 401 | 503; message: string }

/**
 * Checks the shared secret, from `Authorization: Bearer <secret>` or an
 * `x-jobs-secret` header.
 *
 * The comparison is timing-safe. That matters more than it looks: the route is
 * public, unauthenticated and writes to the ledger, so a secret recovered a
 * byte at a time would let anyone grant themselves leave.
 *
 * With no secret configured the routes refuse everything rather than running
 * open. `lib/env.ts` makes that impossible to reach in production.
 */
export function authorizeJobRequest(request: Request): Authorization {
  const expected = env.JOBS_SECRET
  if (!expected) {
    return {
      ok: false,
      status: 503,
      message: 'Job routes are disabled: JOBS_SECRET is not configured.',
    }
  }

  const header = request.headers.get('authorization')
  const bearer = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null
  const presented = bearer ?? request.headers.get('x-jobs-secret')

  if (!presented || !secretsMatch(presented, expected)) {
    return { ok: false, status: 401, message: 'Invalid or missing job secret.' }
  }

  return { ok: true }
}

function secretsMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')

  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length. Hash-free constant work: compare against a padded copy and fold
  // the length check into the result.
  if (a.length !== b.length) {
    timingSafeEqual(a, a)
    return false
  }

  return timingSafeEqual(a, b)
}

/**
 * How far from today an explicit job date may reach. A safety bound on input,
 * not policy: nothing an organization configures depends on it.
 *
 * Behind: two years, so a missed day — or a missed rollover into last year —
 * can always be backfilled, while a typo such as `2002` for `2026` cannot
 * replay decades of accrual.
 *
 * Ahead: one day, which is "today" somewhere east of the server. No job has
 * any business running for a date that has not arrived — a rollover run early
 * would close a year that is still going on, on a ledger that is append-only —
 * and `generate-pay-periods` builds its horizon from the date, one row at a
 * time in a single transaction, so a far-future date would never finish.
 */
export const JOB_DATE_MAX_DAYS_BEHIND = 731
export const JOB_DATE_MAX_DAYS_AHEAD = 1

/**
 * The date a job run is acting on. Defaults to today in `timeZone` — the
 * organization's, which the caller passes (`OrgSettings.timezone`); UTC when it
 * does not, which is right for the scheduled run at 07:00 UTC in the Americas
 * and wrong for anywhere the date has already changed.
 *
 * Every job takes one so that a late run, a backfill and a test are the same
 * code path. Leave dates are DATE columns, so the value is always a UTC
 * midnight and never carries a time of day.
 */
export function jobDate(
  input?: string | null,
  opts: { timeZone?: string; now?: Date } = {},
): Date {
  const today = todayIn(opts.timeZone ?? 'UTC', opts.now)
  if (!input) return today

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    throw new Error(`date must be YYYY-MM-DD, got "${input}"`)
  }

  const date = new Date(`${input}T00:00:00.000Z`)

  // The shape check is not enough. `2026-02-30` is well-formed and parses
  // happily — into March 2, because the day rolls over. A job quietly running
  // for a different date than it was asked to is exactly the kind of failure
  // nobody notices, so the parse has to round-trip.
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== input) {
    throw new Error(`date is not a real date: "${input}"`)
  }

  assertJobDateInWindow(date, today)
  return date
}

/** Refuses a date outside the window above, measured from `today`. */
export function assertJobDateInWindow(date: Date, today: Date): void {
  const earliest = addDays(today, -JOB_DATE_MAX_DAYS_BEHIND)
  const latest = addDays(today, JOB_DATE_MAX_DAYS_AHEAD)
  if (date < earliest || date > latest) {
    const iso = (d: Date) => d.toISOString().slice(0, 10)
    throw new Error(
      `date ${iso(date)} is outside the range a job may run for (${iso(earliest)} to ${iso(latest)}).`,
    )
  }
}
