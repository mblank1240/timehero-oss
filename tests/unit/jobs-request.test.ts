import { describe, expect, it } from 'vitest'

import { authorizeJobRequest, jobDate } from '@/lib/jobs/request'

const SECRET = process.env.JOBS_SECRET

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
    expect(jobDate('2026-06-29').toISOString()).toBe('2026-06-29T00:00:00.000Z')
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
