/**
 * The boot-time environment check (see instrumentation.ts).
 *
 * Next logs an error thrown from `register` and keeps serving, so in
 * production the process exits itself: App Service and Docker then report a
 * failed start instead of a server answering every request with a 500.
 */
try {
  await import('./lib/env')
} catch (error) {
  if (process.env.NODE_ENV !== 'production') throw error
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}

export {}
