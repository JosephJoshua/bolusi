import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'db-server',
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    // Proves the postgres lane reached THIS worktree's database before any test runs, and
    // aborts the whole run if not (testing-guide T-14d). A no-op on the PGlite lane, which is
    // in-process and unshareable by construction. globalSetup — not a per-file beforeAll —
    // because a check that runs after the first file has already migrated and reset a peer's
    // database has reported the crime, not prevented it.
    globalSetup: ['./test/global-setup.ts'],
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
