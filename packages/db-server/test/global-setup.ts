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
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import { migrateToLatest } from '../src/migrator.js';
import {
  assertAttribution,
  createDatabaseFromTemplate,
  databaseNameFor,
  startPgLane,
  TEMPLATE_DATABASE,
  uriForDatabase,
  type PgLane,
} from '../src/testing/pg-container.js';

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

let lane: PgLane | undefined;

export async function setup(project: {
  provide: <K extends 'pgMaintenanceUri' | 'pgOwner' | 'pgBaseUri'>(key: K, value: string) => void;
}): Promise<void> {
  const started = Date.now();

  lane = await startPgLane(async (templateUri) => {
    // The template is migrated exactly once, HERE, and this is the only code permitted to open a
    // connection to it. `db.destroy()` in the finally is not politeness: a surviving connection
    // makes every later `CREATE DATABASE … TEMPLATE` fail with "There is 1 other session using
    // the database", and `assertTemplateUnused` (called immediately after this resolves) is the
    // backstop that turns a leak into a loud, attributed error instead of a distant one.
    const db = new Kysely<unknown>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: templateUri, max: 1 }),
      }),
    });
    try {
      await migrateToLatest(db as never);
    } finally {
      await db.destroy();
    }
  });

  const provenance = await assertAttribution(
    uriForDatabase(lane.container, TEMPLATE_DATABASE),
    lane.owner,
  );

  project.provide('pgMaintenanceUri', lane.maintenanceUri);
  project.provide('pgOwner', lane.owner);
  project.provide('pgBaseUri', lane.container.getConnectionUri());

  // Provenance, printed on every run: which database produced the numbers that follow (§2.1).
  // The template is stamped and verified BEFORE any clone, so every clone inherits a stamp that
  // was checked rather than assumed.
  console.log(
    `db-server: lane UP in ${Date.now() - started}ms — ${provenance} · template '${TEMPLATE_DATABASE}' migrated once`,
  );
}

export async function teardown(): Promise<void> {
  // Best-effort. Ryuk is the guarantee — this is the fast path, not the safety net. If this
  // process is SIGKILLed, `teardown` never runs and Ryuk reaps the container anyway; that is the
  // entire structural argument for testcontainers over the compose lane (task 73).
  await lane?.container.stop();
}

export { createDatabaseFromTemplate, databaseNameFor };
