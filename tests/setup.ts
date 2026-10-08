import { config } from 'dotenv'

// Prefer a committed test profile when one exists, then fall back to the
// developer's .env. CI supplies these as real environment variables, where
// both files are absent and neither call overwrites anything.
config({ path: '.env.test', quiet: true })
config({ path: '.env', quiet: true })

// A unit test must never reach a real database. Anything that opens a
// connection is a mistake to catch here rather than in CI.
process.env.DATABASE_URL ??= 'postgresql://unit-tests-should-not-connect/invalid'
process.env.AUTH_SECRET ??= 'unit-test-secret'
process.env.DEV_AUTH_BYPASS ??= 'true'
