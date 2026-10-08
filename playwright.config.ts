import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT ?? 3100)
// localhost, not 127.0.0.1. Next's dev server treats a 127.0.0.1 origin as
// cross-origin, refuses the HMR websocket upgrade, and hydration never
// runs — so every client component silently stays inert and only tests
// that rely on client state fail. Production is unaffected, which makes
// it an expensive thing to misdiagnose.
const baseURL = `http://localhost:${PORT}`

/** Where the dev server writes mail during the suite; tests/e2e reads it. */
export const MAIL_DIR = '.mail-outbox-e2e'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // The dev server, deliberately. These tests sign in through the dev
    // bypass, and lib/env.ts refuses to start when that is enabled in
    // production — a guard with no test exemption, which is the point of it.
    // The production bundle is still verified by a separate CI build step.
    command: `npx next dev --port ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    env: {
      // Its own build output. Next locks a dist directory to a single dev
      // server, so without this the suite cannot run while a dev server is
      // up — and worse, it would wipe that server's cache mid-session.
      //
      NEXT_DIST_DIR: '.next-e2e',
      // Emailed sign-in links, with mail written to files the tests read.
      AUTH_EMAIL_LINKS: 'true',
      MAIL_TRANSPORT: 'file',
      MAIL_FILE_DIR: MAIL_DIR,
      APP_URL: baseURL,
    },
    timeout: 180_000,
  },
})
