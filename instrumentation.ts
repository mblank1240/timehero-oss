/**
 * Runs once as the server starts. Loading the environment here makes a bad
 * configuration stop the process at boot, with lib/env.ts saying what is
 * wrong, rather than on the first request that happens to import it.
 *
 * The check lives in its own module, imported only on the Node.js runtime:
 * Next also compiles this file for the Edge runtime, which has no
 * `process.exit`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') await import('./instrumentation-node')
}
