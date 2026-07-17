import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'db-client',
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    // Timeouts here are a STARVATION MARGIN, not a work-time budget (task 67, T-10). Every
    // test in this package drives an in-memory better-sqlite3 database whose actual work is
    // sub-millisecond: `dialect.test.ts > "rolls back on error"` measured min=0.33ms /
    // p99=2.0ms / max=6.1ms idle, and max=103ms under 4x CPU oversubscription (loadavg
    // ~109). It never *needs* seconds. But vitest's timeout is WALL-CLOCK, and on this
    // repo's shared, heavily-parallel runner a worker can be descheduled for whole seconds:
    // the default 5000ms was blown by exactly such a freeze during a full monorepo `pnpm
    // test` beside another agent (task 55 merge verification: "Test timed out in 5000ms",
    // green in isolation). Reproduced deterministically by holding a fixed tight timeout and
    // varying only load: the same rollback body is green idle and reds under load.
    // 20000ms is derived, not guessed: ~200x the measured heavy-contention work ceiling
    // (~100ms) and ~4x the single worst freeze ever observed here (the 5000ms incident). A
    // red now requires a worker frozen ~4x longer than anything on record, while a genuinely
    // hung in-memory test still fails within 20s. hookTimeout matches: `beforeEach` runs the
    // migrations — same in-memory engine, same wall-clock starvation exposure.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
