import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'db-server',
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    // Each test file owns a database. On the `pnpm test:rls` lane that means resetting the
    // schema of ONE shared postgres database, so files must not run concurrently. On PGlite
    // each file boots its own in-memory postgres; serialising costs a little time and buys
    // identical behaviour across both lanes.
    fileParallelism: false,
    // Booting PGlite (WASM) plus a full migrate is well past vitest's 5s default.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
