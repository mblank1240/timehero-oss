import { describe, expect, it } from 'vitest'

import { authorizeJobRequest, jobDate } from '@/lib/jobs/request'

const SECRET = process.env.JOBS_SECRET
const NOW = new Date('2026-06-29T12:00:00Z')
const iso = (date: Date) => date.toISOString().slice(0, 10)

function post(headers: Record<string, string> = {}): Request {
  return new Request('https://example.test/api/jobs/accrue-pay-period', {
    method: 'POST',
    headers,
  })
}

describe('jobDate', () => {
  it('defaults to today at UTC midnight', () => {
    const date = jobDate()
    const now = new Date()

    expect(date.toISOString()).toMatch(/T00:00:00\.000Z$/)
    expect(date.toISOString().slice(0, 10)).toBe(now.toISOString().slice(0, 10))
  })

  it('parses an explicit date as a UTC midnight', () => {
    expect(jobDate('2026-06-29', { now: NOW }).toISOString()).toBe('2026-06-29T00:00:00.000Z')
  })

  /**
   * The scheduled run fires at a UTC hour; "today" is the organization's.
   * 12:00 UTC on 29 June is already 30 June at UTC+14, and 03:00 UTC is still
   * 28 June in Los Angeles.
   */
  it('defaults to today in the organization’s time zone', () => {
    expect(iso(jobDate(null, { timeZone: 'Pacific/Kiritimati', now: NOW }))).toBe('2026-06-30')
    expect(
      iso(jobDate(null, { timeZone: 'America/Los_Angeles', now: new Date('2026-06-29T03:00:00Z') })),
    ).toBe('2026-06-28')
  })

  /**
   * Two years back — 731 days before 29 June 2026 is 28 June 2024 — and one
   * day ahead. A typo'd year must not replay decades, and nothing may run for
   * a date that has not arrived.
   */
  it('refuses a date outside the safety window around today', () => {
    expect(iso(jobDate('2024-06-28', { now: NOW }))).toBe('2024-06-28')
    expect(() => jobDate('2024-06-27', { now: NOW })).toThrow(/outside the range/)

    expect(iso(jobDate('2026-06-30', { now: NOW }))).toBe('2026-06-30')
    expect(() => jobDate('2026-07-01', { now: NOW })).toThrow(/outside the range/)
    expect(() => jobDate('9999-12-31', { now: NOW })).toThrow(/outside the range/)
  })

  it('measures the window from the organization’s today', () => {
    // 30 June at UTC+14, so 1 July is "tomorrow" there.
    expect(iso(jobDate('2026-07-01', { timeZone: 'Pacific/Kiritimati', now: NOW }))).toBe(
      '2026-07-01',
    )
  })

  it('treats an empty value as absent', () => {
    expect(jobDate('').toISOString()).toMatch(/T00:00:00\.000Z$/)
    expect(jobDate(null).toISOString()).toMatch(/T00:00:00\.000Z$/)
  })

  /** A loose parse would silently run a job for the wrong day. */
  it('rejects anything that is not YYYY-MM-DD', () => {
    expect(() => jobDate('29/06/2026')).toThrow()
    expect(() => jobDate('2026-6-29')).toThrow()
    expect(() => jobDate('2026-06-29T12:00:00Z')).toThrow()
    expect(() => jobDate('yesterday')).toThrow()
  })

  it('rejects a well-shaped date that is not a real one', () => {
    expect(() => jobDate('2026-13-01')).toThrow()
    expect(() => jobDate('2026-02-30')).toThrow()
  })
})

describe('authorizeJobRequest', () => {
  // Guarded rather than skipped: without a secret these assertions would pass
  // vacuously, which is worse than not running them.
  const configured = Boolean(SECRET)

  it.runIf(configured)('accepts the secret as a bearer token', () => {
    expect(authorizeJobRequest(post({ authorization: `Bearer ${SECRET}` }))).toEqual({ ok: true })
  })

  it.runIf(configured)('accepts the x-jobs-secret header', () => {
    expect(authorizeJobRequest(post({ 'x-jobs-secret': SECRET! }))).toEqual({ ok: true })
  })

  it.runIf(configured)('rejects a missing secret', () => {
    expect(authorizeJobRequest(post())).toMatchObject({ ok: false, status: 401 })
  })

  it.runIf(configured)('rejects a wrong secret of the same length', () => {
    const wrong = 'x'.repeat(SECRET!.length)
    expect(authorizeJobRequest(post({ authorization: `Bearer ${wrong}` }))).toMatchObject({
      ok: false,
      status: 401,
    })
  })

  it.runIf(configured)('rejects a secret of a different length without throwing', () => {
    expect(authorizeJobRequest(post({ 'x-jobs-secret': 'short' }))).toMatchObject({
      ok: false,
      status: 401,
    })
  })

  it.runIf(configured)('rejects a prefix of the real secret', () => {
    expect(
      authorizeJobRequest(post({ 'x-jobs-secret': SECRET!.slice(0, -1) })),
    ).toMatchObject({ ok: false, status: 401 })
  })

  it.skipIf(configured)('refuses every request when no secret is configured', () => {
    expect(authorizeJobRequest(post())).toMatchObject({ ok: false, status: 503 })
  })
})
