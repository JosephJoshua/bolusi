import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'server',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Several suites boot a PGlite instance + full migrate per test (media, task 19) or run real
    // argon2id (identity, task 13); parallel files contend on CPU and time out. Serialise files as
    // db-server's RLS suite does, and give DB-backed tests the same headroom. Fast in-process
    // app.fetch suites are unaffected by the higher ceilings.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
