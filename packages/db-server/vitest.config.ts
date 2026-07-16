import { defineConfig } from 'vitest/config';

import { MAX_PARALLEL_FILES } from './src/testing/budget.js';

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
    // The old comment here was honest for the lane it described: "each test file owns a database.
    // On the `pnpm test:rls` lane that means resetting the schema of ONE shared postgres database,
    // so files must not run concurrently." That premise — one shared database — is what task 73
    // removed: each file now CLONES its own database from a pre-migrated template (a filesystem
    // copy, milliseconds), so there is no shared schema left to race.
    //
    // NOTE what this does NOT claim. The PGlite half of the old reason was **never** about cost:
    // main's own comment says PGlite files were serialised because doing so "buys identical
    // behaviour across both lanes" — a deliberate choice to match the shared-DB postgres lane, not
    // a WASM-boot tax. Parallelised PGlite is ~14 s. This lane is not here because it is faster
    // than the substitute; it is here because the substitute is BLIND (D16 — measured: PGlite
    // 14/14 GREEN vs real PG16 4 RED on the same int8 defect). It is 4.8× faster than the real-PG
    // lane it replaces, which is a bonus, not the argument.
    maxWorkers: MAX_PARALLEL_FILES,
    // groupOrder: this project runs in its OWN group, after every other project.
    //
    // TWO reasons, and the first is not optional. (1) vitest 4 REFUSES to run projects that share
    // a `sequence.groupOrder` but declare different `maxWorkers`: "Projects "db-client" and
    // "db-server" have different 'maxWorkers' but same 'sequence.groupOrder'". Unset means every
    // project shares the implicit group, so `maxWorkers` here — the only one in the repo — made
    // `pnpm test` collect ZERO tests and exit 1 while `pnpm test:rls` stayed green, because a
    // single-project run has nothing to conflict with. That is why review-73 caught it and this
    // lane's own verification did not. (2) It is also correct on the merits: this project owns a
    // container and 24 workers, and letting it contend with the other ~128 files is what the old
    // `fileParallelism: false` was working around.
    //
    // The cost, stated: the full suite's wall-clock becomes group0 + db-server rather than
    // max(group0, db-server). Paid deliberately for a lane that must not be starved of workers.
    sequence: { groupOrder: 1 },
    // A clone is milliseconds, but container boot is seconds and this box runs 76 containers;
    // db-lane.mjs records a real flake where an init checkpoint took 31 s. Keep the headroom.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
