import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'db-server',
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    // Boots ONE real postgres:16 container, migrates a template ONCE, and proves the lane reached
    // a database THIS run owns before any test runs (D16, task 73; testing-guide T-14d). It is a
    // globalSetup — not a per-file beforeAll — because a check that runs after the first file has
    // already migrated and reset a peer's database has reported the crime, not prevented it.
    globalSetup: ['./test/global-setup.ts'],
    // fileParallelism: RE-ENABLED (was `false`).
    //
    // The old comment here was honest and its reasoning was sound for the lane it described:
    // "each test file owns a database. On the `pnpm test:rls` lane that means resetting the schema
    // of ONE shared postgres database, so files must not run concurrently."
    //
    // The premise — one shared database — is what task 73 removed. Each file now CLONES its own
    // database from a pre-migrated template (`CREATE DATABASE … TEMPLATE`, a filesystem copy,
    // milliseconds), so there is no shared schema left to race and nothing to serialise for. The
    // PGlite half of the old reason ("booting PGlite + a full migrate per file") is gone with the
    // engine.
    //
    // maxWorkers is NOT vitest's default here, and the number is derived rather than picked:
    // `max_connections` is the real ceiling, not database count. 24 files × 2 conns/file + 10
    // headroom = 58 ≤ 200 − 3 reserved. `assertConnectionBudget` re-derives this against the LIVE
    // server at boot and aborts if the two ever disagree, so this comment cannot quietly rot into
    // `FATAL: sorry, too many clients already` in an unrelated file (T-14: a guard asserts its own
    // denominator).
    maxWorkers: 24,
    // A clone is milliseconds, but container boot is seconds and this box runs 76 containers;
    // db-lane.mjs records a real flake where an init checkpoint took 31 s. Keep the headroom.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
