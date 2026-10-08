import { describe, expect, it } from 'vitest'

import { MIN_SECRET_LENGTH, envSchema } from '@/lib/env'

const long = 'x'.repeat(MIN_SECRET_LENGTH)

/** A production environment that passes, for each test to break one way. */
const production = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://app@db:5432/timehero',
  AUTH_SECRET: long,
  JOBS_SECRET: long,
  APP_URL: 'https://time.example.org',
  AUTH_GOOGLE_ID: 'id',
  AUTH_GOOGLE_SECRET: 'secret',
}

const issuesFor = (env: Record<string, string>) => {
  const result = envSchema.safeParse(env)
  return result.success ? [] : result.error.issues.map((i) => i.path.join('.'))
}

describe('environment secrets', () => {
  it('accepts a production environment with long secrets', () => {
    expect(issuesFor(production)).toEqual([])
  })

  it('refuses a short AUTH_SECRET in production', () => {
    expect(issuesFor({ ...production, AUTH_SECRET: 'x'.repeat(MIN_SECRET_LENGTH - 1) })).toEqual([
      'AUTH_SECRET',
    ])
  })

  it('refuses a short JOBS_SECRET in production', () => {
    expect(issuesFor({ ...production, JOBS_SECRET: 'short' })).toEqual(['JOBS_SECRET'])
  })

  it('leaves development and test alone', () => {
    for (const NODE_ENV of ['development', 'test']) {
      expect(
        issuesFor({ ...production, NODE_ENV, AUTH_SECRET: 'dev', JOBS_SECRET: 'dev', APP_URL: '' }),
      ).toEqual([])
    }
  })

  it('requires APP_URL in production', () => {
    expect(issuesFor({ ...production, APP_URL: '' })).toEqual(['APP_URL'])
  })

  it('refuses the development mail transports in production', () => {
    expect(issuesFor({ ...production, MAIL_TRANSPORT: 'file' })).toEqual(['MAIL_TRANSPORT'])
    expect(issuesFor({ ...production, MAIL_TRANSPORT: 'console' })).toEqual(['MAIL_TRANSPORT'])
    expect(issuesFor({ ...production, NODE_ENV: 'development', MAIL_TRANSPORT: 'file' })).toEqual(
      [],
    )
  })
})
