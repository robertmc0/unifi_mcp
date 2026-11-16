import { defineConfig } from 'vitest/config';

/**
 * Opt-in container tests (`npm run test:containers`): the shipped Compose files on a local
 * Docker engine, with the image under test. Never part of `npm run check`. See
 * tests/container-network/ and docs/networking.md.
 */
export default defineConfig({
  test: {
    include: ['tests/container-network/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 240_000,
    // One Docker engine: the files share networks and ports.
    fileParallelism: false,
  },
});
