/**
 * Runs once as the server starts. Loading the environment here makes a bad
 * configuration stop the process at boot, with lib/env.ts saying what is
 * wrong, rather than on the first request that happens to import it.
 *
 * Next logs an error thrown from `register` and keeps serving, so in
 * production the process exits itself: App Service and Docker then report a
 * failed start instead of a server answering every request with a 500.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  try {
    await import('./lib/env')
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') throw error
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
