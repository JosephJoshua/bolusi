// apps/server's L3 lane: the SAME real postgres:16 container machinery db-server runs, reached
// through `@bolusi/db-server/testing` so `pg` NEVER crosses the boundary (task 81; 08 §3.3 keeps
// `pg` owned by db-server). The whole bring-up — boot, migrate-once, assert-attribution, provide,
// log, budget-check-against-live-maxWorkers — is `setupPgLane`, written once in the seam (§2.8);
// this file is the two-line delegation.
//
// WHY apps/server GETS ITS OWN CONTAINER (not db-server's). vitest `provide` is per-project — a
// value db-server's globalSetup provides is injectable only by db-server's tests — and the
// connection-budget guard must check THIS project's live `maxWorkers` against the container it will
// actually use. A root-level, project-blind setup could satisfy neither, and sharing one container
// across two projects is exactly the kind of provenance blur (which database answered?) D16 closes.
// The two projects run in different `sequence.groupOrder`s, so the two containers are never both hot.
import { setupPgLane } from '@bolusi/db-server/testing';

// The lane values `setupPgLane` publishes, injected by this project's test helpers via `inject`.
// Declared here (a test file, where `vitest` resolves) rather than in the seam's `src`, which
// cannot resolve the test-only `vitest` devDep. Identical to db-server's own augmentation.
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
