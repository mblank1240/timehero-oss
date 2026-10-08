import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    // Modules under test reach lib/env.ts through their imports, and it throws
    // on an incomplete environment by design. Load .env so unit tests run
    // against the same contract the app does.
    setupFiles: ['tests/setup.ts'],
  },
})
