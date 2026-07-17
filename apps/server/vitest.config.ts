import { defineConfig } from 'vitest/config';

// The connection budget's ONE definition (CLAUDE.md §2.8), imported from a subpath that has NO
// runtime deps — NOT `@bolusi/db-server/testing`, which would drag `@testcontainers/postgresql`
// and `pg` into config resolution (budget.ts's own header explains why it is a separate module).
import { MAX_PARALLEL_FILES } from '@bolusi/db-server/testing/budget';

export default defineConfig({
  test: {
    name: 'server',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Boots THIS project's own real postgres:16 container, migrates a template once, clones a
    // database per file, and proves this run owns it before any test runs (D16, task 81; T-14d).
    // A globalSetup, not a per-file beforeAll, so a foreign/absent stamp aborts the run before the
    // first file rather than after it has already migrated a peer's database.
    globalSetup: ['./test/global-setup.ts'],
    // fileParallelism: RE-ENABLED (was `false`).
    //
    // The old reason — "several suites boot a PGlite instance + full migrate per test … parallel
    // files contend on CPU and time out" — is gone with PGlite. Every DB-backed file now CLONES its
    // own database from a pre-migrated template (a filesystem copy, milliseconds; no WASM boot, no
    // migrate), so there is nothing left to serialise for. The move is for FIDELITY, not speed: the
    // substitute is measurably blind to the silent int8-marshalling class (D16 / T-14f), and the
    // production push pipeline, validation stages, conflict-detection and projection-apply all live
    // in this package and were witnessed only by that blind lane.
    maxWorkers: MAX_PARALLEL_FILES,
    // groupOrder: this project runs in its OWN group (2), after db-server (1) and the fast projects
    // (implicit 0).
    //
    // NOT optional. vitest 4 REFUSES to run projects that share a `sequence.groupOrder` but declare
    // different `maxWorkers` ("Projects … have different 'maxWorkers' but same 'sequence.groupOrder'").
    // This project and db-server are the only two that set `maxWorkers`; leaving this unset would put
    // `server` in the implicit group 0 alongside every project that sets NO maxWorkers, whose value
    // differs — and that conflict made `pnpm test` collect ZERO tests while `test:server` alone (a
    // single-project run with nothing to conflict with) stayed green. That is the exact trap that
    // blocked task 73's merge; db-server sits in group 1, so this project must NOT reuse it either
    // (same-group-different-maxWorkers is the failure) and takes group 2. The cost is that the full
    // suite's wall-clock becomes group0 + db-server + server rather than their max; paid so a lane
    // that owns a container and 24 workers is never starved contending with ~128 other files.
    sequence: { groupOrder: 2 },
    // Clone is milliseconds, but container boot is seconds and this box runs many containers; keep
    // the headroom db-server keeps.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
