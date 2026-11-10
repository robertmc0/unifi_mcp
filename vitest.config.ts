import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    // Live UniFi tests are opt-in only (spec §16 / decision 21) and never run by default.
    exclude: ['**/node_modules/**', 'tests/integration-live-readonly/**'],
    environment: 'node',
    restoreMocks: true,
  },
});
