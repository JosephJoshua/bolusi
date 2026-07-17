// THE L3 LANE'S ONE CONTAINER — booted once, template migrated once, cloned per file (D16/73).
//
// This replaces the compose lane's attribution gate (task 34). It keeps every property that gate
// bought and drops the one thing it could not close by construction: the leak.
//
//   property (T-14d)              how it is kept here
//   ----------------------------  --------------------------------------------------------------
//   ephemeral, per-run port       `getConnectionUri()` is DERIVED from the container this process
//                                 started. There is no fixed port left to fall back to, so a dead
//                                 container cannot silently resolve to a live peer's.
//   a FATAL failure to start      `startPgLane` does not catch; a rejected `start()` aborts the
//                                 run before a single test file is spawned.
//   attribution ASSERTED          every database carries a `bolusi.db_owner` stamp naming THIS
//                                 run; `assertAttribution` refuses an absent or foreign stamp.
//   nobody has to remember        Ryuk reaps the container however the run dies — including
//   `db:down`                     SIGKILL, which no `finally` block survives.
//
// WHY THE PGlite BRANCH IS GONE FROM THIS PACKAGE (D16, and it is a ruling)
// -------------------------------------------------------------------------
// `db-server`'s suite IS the RLS, driver-marshalling and version witness. D16 rule 3 permits a
// substitute only where it proves something the real thing also proves, and NEVER as the sole
// witness for a claim about the driver, RLS, or a version-sensitive behaviour — which is this
// package's entire subject. Keeping a `BOLUSI_DB_ENGINE=pglite` path here would leave a green
// reachable by `vitest run --project db-server` that is vacuous for exactly the reasons T-14b and
// T-14f record. So the switch is deleted rather than defaulted: the lane cannot be downgraded to
// WASM because there is no longer a WASM path to downgrade to.
//
// The cost is stated plainly: `pnpm test` now needs a working Docker daemon. That is D16's
// accepted price, and it is the same price CI already pays.
//
// THE BRING-UP ITSELF LIVES IN THE SEAM (task 81, §2.8). Boot → migrate-once → assert-attribution
// → provide → log is identical for every project that runs L3 (this one, and apps/server's), so it
// is `setupPgLane` in `src/testing/pg-container.ts`, and this file is a two-line delegation. Each
// project keeps its OWN container and its OWN budget check against its OWN live maxWorkers — that
// part is per-project by construction (vitest `provide` is per-project; the review-73 fix reads the
// live number) — but the code that performs it is written once.
import { setupPgLane } from '../src/testing/pg-container.js';

// The lane values `setupPgLane` publishes, injected by this project's test files via `inject`.
// Lives here (a test file) rather than in the seam because `src` cannot resolve `vitest` (§08 §3.3
// test-only devDep). apps/server's globalSetup carries the identical augmentation for its own tests.
declare module 'vitest' {
  export interface ProvidedContext {
    /** Maintenance-database URI — clones are issued from here, never from the template. */
    pgMaintenanceUri: string;
    /** The token every database of this run is stamped with (T-14d). */
    pgOwner: string;
    /** Base URI whose database component each file swaps for its own clone. */
    pgBaseUri: string;
  }
}

let teardownLane: (() => Promise<void>) | undefined;

export async function setup(project: Parameters<typeof setupPgLane>[0]): Promise<void> {
  teardownLane = await setupPgLane(project);
}

export async function teardown(): Promise<void> {
  await teardownLane?.();
}
