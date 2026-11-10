import { defineConfig } from 'vitest/config';

/**
 * Opt-in live read-only tests against a real console (`npm run test:live`). Never used by
 * `npm run check` or CI. See tests/integration-live-readonly/ and docs/applications-network.md.
 */
export default defineConfig({
  test: {
    include: ['tests/integration-live-readonly/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
  },
});
