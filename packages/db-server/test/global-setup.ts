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

interface GlobalSetupProject {
  provide: <K extends 'pgMaintenanceUri' | 'pgOwner' | 'pgBaseUri'>(key: K, value: string) => void;
  config?: { maxWorkers?: unknown };
}

/**
 * The worker count VITEST ACTUALLY RESOLVED, read from the live project config.
 *
 * Not `MAX_PARALLEL_FILES`. The budget guard exists to compare the real parallelism against the
 * real server, and review-73 proved that distinction IS the guard: when it compared its own
 * constant instead, `maxWorkers: 110` sailed through (24 × 2 + 10 ≤ 197) while the run opened
 * 220 connections. Reading the number from the object vitest hands us, after it has resolved the
 * config, is what makes it un-fakeable.
 *
 * It THROWS rather than defaulting. A `?? MAX_PARALLEL_FILES` here would resurrect the exact
 * defect — the guard would quietly check the constant again and nothing downstream could tell
 * the difference (T-19: a default that is plausible in the domain is indistinguishable from a
 * real reading).
 */
function resolveMaxWorkers(project: GlobalSetupProject): number {
  const raw = project.config?.maxWorkers;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  throw new Error(
    `db-server: ABORT — vitest's resolved maxWorkers is ${JSON.stringify(raw)}, not a positive ` +
      'integer, so the connection budget cannot be checked against the parallelism this run will ' +
      'actually use.\n' +
      'vitest.config.ts must set `maxWorkers` to a number (it imports MAX_PARALLEL_FILES from ' +
      'src/testing/budget.ts). Refusing rather than assuming: a guard that assumes its own ' +
      'answer is the defect review-73 found here (task 73).',
  );
}

export async function setup(project: GlobalSetupProject): Promise<void> {
  const started = Date.now();
  const maxWorkers = resolveMaxWorkers(project);

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
  }, maxWorkers);

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
    `db-server: lane UP in ${Date.now() - started}ms — ${provenance} · template ` +
      `'${TEMPLATE_DATABASE}' migrated once · budget OK for ${maxWorkers} live workers`,
  );
}

export async function teardown(): Promise<void> {
  // Best-effort. Ryuk is the guarantee — this is the fast path, not the safety net. If this
  // process is SIGKILLed, `teardown` never runs and Ryuk reaps the container anyway; that is the
  // entire structural argument for testcontainers over the compose lane (task 73).
  await lane?.container.stop();
}

export { createDatabaseFromTemplate, databaseNameFor };
