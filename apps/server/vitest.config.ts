import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'server',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // The media integration suite (task 19) boots a PGlite instance + full migrate per test, like
    // db-server's RLS suite. Serialise files so many PGlite instances don't thrash the machine (which
    // starved the tenant PGlite test under the 5s default), and give DB-backed tests the same
    // headroom db-server uses. Fast in-process app.fetch suites are unaffected by the higher ceilings.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
