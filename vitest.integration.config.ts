import { defineConfig } from 'vitest/config'

/**
 * Integration tests, against a real Postgres.
 *
 * Kept out of `npm test` deliberately: the unit suite is pure and has to stay
 * runnable with nothing installed but node. These need a migrated, seeded
 * database, which CI provides and a developer gets from `npm run db:migrate`.
 *
 * They run in a single thread. The jobs they exercise are org-wide and write
 * to a shared ledger, so two files running at once would be two scheduled runs
 * racing — which is a real scenario, but not one to discover through a flaky
 * test.
 */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    env: {
      // Emailed sign-in links are a deployment switch; the suite exercises
      // them, writing mail to files (the default transport outside production).
      AUTH_EMAIL_LINKS: 'true',
      // A throwaway key pair, so push is "configured". Nothing reaches a push
      // service: tests/integration/notifications.test.ts mocks the sender.
      VAPID_PUBLIC_KEY:
        'BPYMw-F644kNbCpj5k8Tykl9MjTtNWj28dfEOdVhxxJEjRDu7ZMQbHCk4LWogg2NOuiqzegYc26HCCTwH11XjwU',
      VAPID_PRIVATE_KEY: 'JYRvOCrMhRoLVm506r7qMG-kYqYeP8XmmRr3SGZjHqY',
      VAPID_SUBJECT: 'mailto:tests@example.test',
    },
  },
})
