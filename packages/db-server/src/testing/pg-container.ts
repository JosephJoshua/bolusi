// The L3 real-Postgres lane: one container, migrated ONCE, cloned per test file (D16, task 73).
//
// WHY THIS FILE EXISTS, AND WHY IT LIVES IN db-server
// ---------------------------------------------------
// D16 is an owner directive: integration tests run against the real dependency, in a container,
// pinned to the production major — never PGlite, never a WASM embed, never a mock. The evidence
// is measured, not asserted: reproduced again while building this file, on `pg` 8.22.0 / PG 16.14
// with the int8 seam reverted at `reconstructOperation`:
//
//   lane                        result
//   --------------------------  ---------------------------------------------
//   PGlite (the substitute)     14/14 GREEN, EXIT=0   ← blind to the defect
//   real PG16 over real `pg`     4 RED / 10 pass, EXIT=1
//
// with the discriminating assertion reading `expected [ '10', '9' ] to deeply equal [ 9, 10 ]` —
// seq 10 sorting BEFORE seq 9, because the driver hands int8 back as a STRING and `"10" < "9"`
// is lexicographically true. That is the third independent measurement of the same class (tasks
// 46, 48, and this one), and the numbers match task 48's exactly.
//
// It lives in `db-server` because `pg` is boundary-locked here (08 §3.3) and because a lane that
// lives once is a lane that cannot drift from a copy (CLAUDE.md §2.8). It is exported under the
// `./testing` subpath so `apps/server` can reach a real PG16 database WITHOUT importing `pg` —
// see this package's package.json and task 73's boundary ruling.
//
// THE DESIGN, AND WHICH PARTS ARE LOAD-BEARING
// ---------------------------------------------
//   1. ONE `postgres:16` container per suite run  (production major, pinned in code)
//   2. migrate ONCE into a template database      (the expensive step, paid once)
//   3. per test file: CREATE DATABASE … TEMPLATE  (a filesystem copy — milliseconds)
//   4. therefore fileParallelism can be re-enabled (each file owns a database)
//
// Step 3 is what inverts the old cost model. PGlite booted a WASM Postgres **and a full migrate
// per test file**, which is precisely why `fileParallelism: false` was set in this package and in
// apps/server — the substitute picked for speed was the *cause* of 65 files running strictly
// serially on a 48-core box at ~96% idle.
//
// WHAT `db-lane.mjs` BOUGHT AND THIS MUST NOT LOSE (T-14d)
// --------------------------------------------------------
// A fixed host port once let a failed `db:up` resolve to a PEER WORKTREE's database, and task
// 13's "82/11 on real PG16" was produced by task 05's leaked container — a real number with
// fictional provenance. Preserved here:
//   - ephemeral ports BY CONSTRUCTION — `getConnectionUri()` is derived from the container this
//     process started; there is no fixed port left to fall back to;
//   - a FATAL start failure — `start()` rejects and globalSetup does not catch it;
//   - attribution ASSERTED, not advisory — every clone carries a `bolusi.db_owner` stamp naming
//     the run that created it, and `assertAttribution` refuses an absent or foreign stamp.
//
// WHY NOT `.withReuse()` — THE ONE PLACE THIS FILE CONTRADICTS ITS OWN BRIEF
// ---------------------------------------------------------------------------
// D16 and task 73 both suggest `.withReuse()` as the cost mitigation, and both name Ryuk as the
// main structural benefit. **Those two are mutually exclusive**, which is visible in
// testcontainers 12.0.4's own source (generic-container.js:79-86):
//
//     if (process.env.TESTCONTAINERS_REUSE_ENABLE !== "false" && this.reuse) {
//         return this.reuseOrStartContainer(client);      // ← returns HERE
//     }
//     if (!this.isReaper() && this.autoCleanup) {
//         const reaper = await getReaper(client);          // ← never reached when reusing
//         this.createOpts.Labels = { ..., [LABEL_TESTCONTAINERS_SESSION_ID]: reaper.sessionId };
//     }
//
// The reuse path returns BEFORE the reaper is started and never applies the `session-id` label
// that Ryuk reaps by. A reused container is therefore never cleaned up — it outlives the run
// that created it, which is the leaked-container class of T-14d re-created by the mitigation.
// This is not a reading of the docs: a container with exactly that fingerprint (an
// `org.testcontainers.container-hash` label, NO `session-id`, testcontainers 12.0.4) has been
// running on this box for 13 days.
//
// Reuse buys the amortised cost of ONE container boot (~2 s across a whole suite). It costs the
// entire structural argument for preferring testcontainers over the hand-rolled compose lane.
// So: no reuse. The container is started per run and Ryuk reaps it however the run dies.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import { createCamelCasePlugin } from '../camel-case.js';
import type { DB } from '../generated/db.js';
import { migrateToLatest } from '../migrator.js';
import { HEADROOM, MAX_CONNECTIONS, POOL_PER_FILE } from './budget.js';

/** The production major, stated in code where a test can read it (D16, T-14f rule 3). */
export const PG_IMAGE = 'postgres:16';

/** The database-level GUC naming the run that owns a database (T-14d, mirrors pg-init). */
export const DB_OWNER_SETTING = 'bolusi.db_owner';

/** The pre-migrated database every test database is cloned from. NEVER connect to it. */
export const TEMPLATE_DATABASE = 'bolusi_tmpl';

/**
 * The maintenance database `CREATE DATABASE` is issued from.
 *
 * Deliberately NOT the template: `CREATE DATABASE … TEMPLATE x` fails while ANY session holds
 * `x`, so the connection issuing the clone must not be the thing that blocks it.
 */
const MAINTENANCE_DATABASE = 'postgres';

export { HEADROOM, MAX_CONNECTIONS, MAX_PARALLEL_FILES, POOL_PER_FILE } from './budget.js';

export interface PgLane {
  readonly container: StartedPostgreSqlContainer;
  /** Connection URI for the MAINTENANCE database — never the template. */
  readonly maintenanceUri: string;
  /** The token every database of this run is stamped with. */
  readonly owner: string;
}

/**
 * Boots the container, migrates the template ONCE, and stamps it.
 *
 * `migrate` receives a URI for the template and MUST close every connection it opens before
 * resolving — `assertTemplateUnused` is the backstop that makes a leak fail loudly rather than
 * turn every later clone into an unexplained error.
 *
 * A failure to start is FATAL by construction: `start()` rejects, and nothing here catches it.
 * There is no ordering in which a failed boot is followed by a green test (db-lane.mjs's rule,
 * kept).
 */
export async function startPgLane(
  migrate: (templateUri: string) => Promise<void>,
  actualMaxWorkers: number,
): Promise<PgLane> {
  // A token unique to THIS process, so a database created by any other run is detectably foreign.
  const owner = `task73-${process.pid}-${Date.now().toString(36)}`;

  const container = await new PostgreSqlContainer(PG_IMAGE)
    // No `.withReuse()` — see this file's header. Reuse silently opts out of Ryuk, which is the
    // one structural reason to be on testcontainers at all.
    .withCommand([
      'postgres',
      '-c',
      `max_connections=${MAX_CONNECTIONS}`,
      // DURABILITY OFF — this container is EPHEMERAL (Ryuk reaps it; its data never outlives the
      // run), so crash-safety buys nothing and its cost is real. `CREATE DATABASE … TEMPLATE` forces
      // a checkpoint + fsync of the whole cluster; under `apps/server`'s per-file clone parallelism
      // on a shared box that fsync storm is what took the container into "the database system is in
      // recovery mode" (task 81, measured — 43/54 files failed with the flags OFF). Turning fsync,
      // synchronous_commit and full_page_writes off removes the disk-durability work an ephemeral
      // test cluster has no use for and makes the clone a memory/copy op. Standard for a throwaway
      // test Postgres; NEVER for production.
      '-c',
      'fsync=off',
      '-c',
      'synchronous_commit=off',
      '-c',
      'full_page_writes=off',
    ])
    // db-lane.mjs records a real flake: an init checkpoint took 31 s and overran a healthcheck
    // start period. This box runs 76 containers; be generous rather than flaky (T-10).
    .withStartupTimeout(180_000)
    .start();

  const maintenanceUri = uriForDatabase(container, MAINTENANCE_DATABASE);

  await assertConnectionBudget(maintenanceUri, actualMaxWorkers);

  // Create the template, migrate it, stamp it — then never touch it again.
  await withAdmin(maintenanceUri, async (client) => {
    await client.query(`CREATE DATABASE ${quoteIdent(TEMPLATE_DATABASE)}`);
    await stampOwner(client, TEMPLATE_DATABASE, owner);
  });

  await migrate(uriForDatabase(container, TEMPLATE_DATABASE));

  // THE HINGE OF THE WHOLE DESIGN. If `migrate` left a connection open, every clone below fails
  // with `There is 1 other session using the database` — a confusing error at a distant call
  // site. Assert it HERE, where the cause is, and say what to do about it.
  await assertTemplateUnused(maintenanceUri);

  return { container, maintenanceUri, owner };
}

/**
 * Clones a fresh database from the template. Milliseconds: a filesystem-level copy, no migrate.
 *
 * @param name unique per test file — derive it deterministically (see `databaseNameFor`) so a
 *   failure names the file that produced it and is reproducible from the name alone.
 */
export async function createDatabaseFromTemplate(
  lane: Pick<PgLane, 'maintenanceUri'>,
  name: string,
  owner: string,
): Promise<void> {
  await assertTemplateUnused(lane.maintenanceUri);
  await withAdmin(lane.maintenanceUri, async (client) => {
    await client.query(
      `CREATE DATABASE ${quoteIdent(name)} TEMPLATE ${quoteIdent(TEMPLATE_DATABASE)}`,
    );
    // THE STAMP DOES NOT SURVIVE THE CLONE — measured, after this file's first version asserted
    // the opposite in a comment and was wrong (task 73).
    //
    //   CREATE DATABASE probe_clone TEMPLATE probe_src;   -- probe_src stamped 'STAMPED'
    //   probe_src   -> STAMPED
    //   probe_clone -> (ABSENT)
    //
    // The reason is structural, not a quirk: `ALTER DATABASE … SET` writes `pg_db_role_setting`,
    // a SHARED catalog keyed by database OID. `CREATE DATABASE … TEMPLATE` copies the template's
    // DATA DIRECTORY; it does not copy rows out of a shared catalog, and the clone has a new OID
    // anyway. So each clone is stamped explicitly, here, at the moment it is created.
    //
    // This does NOT reintroduce the "verification must never provision" hazard db-lane.mjs warns
    // about. That rule exists so a FOREIGN database cannot be adopted by the check meant to reject
    // it. Here the stamp is written by the code that just executed `CREATE DATABASE` — a database
    // this line created cannot be foreign — while `assertAttribution` (which only ever READS) runs
    // later, on the test's own connection. Provisioning and verification are still two different
    // functions called from two different places.
    await stampOwner(client, name, owner);
  });
}

/** Writes the attribution stamp for a database this process just created. Never for one it found. */
async function stampOwner(client: pg.Client, database: string, owner: string): Promise<void> {
  await client.query(
    `ALTER DATABASE ${quoteIdent(database)} SET ${DB_OWNER_SETTING} = ${quoteLiteral(owner)}`,
  );
}

/**
 * Fails unless the template has ZERO sessions — the one rule that makes the design work.
 *
 * Measured on PG 16.14 (and re-measured by this task): a clone with no connections to the
 * template succeeds; a clone while ONE session holds it fails with
 * `DETAIL: There is 1 other session using the database.`
 *
 * This TERMINATES stragglers and then re-checks, rather than terminating blindly and hoping:
 * a guard that cannot report what it found has reported nothing. If a connection survives
 * termination, that is a bug in the caller (something is reconnecting), and the loud failure is
 * the correct outcome — never a retry loop, which would convert a deterministic bug into a flake.
 */
export async function assertTemplateUnused(maintenanceUri: string): Promise<void> {
  await withAdmin(maintenanceUri, async (client) => {
    const countSessions = async (): Promise<number> => {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [TEMPLATE_DATABASE],
      );
      return Number(rows[0]?.n ?? '0');
    };

    if ((await countSessions()) === 0) return;

    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TEMPLATE_DATABASE],
    );

    // `pg_terminate_backend` SIGNALS a backend; it does not synchronously reap it. An immediate
    // re-check therefore races the backend's exit and reports sessions that are already dying.
    //
    // This is not a hypothetical tightening: the first version of this function re-checked
    // immediately and FAILED its own falsification probe — it threw "1 session(s) still hold
    // template" for a plain `pg.Client` that had in fact been terminated successfully. Shipped,
    // that would have been a flake (T-10) in the one guard the whole design hinges on.
    //
    // So: wait for the signal to TAKE EFFECT, bounded. This is not "retry blindly" — the loop
    // waits only for a termination already issued, and a session that keeps RECONNECTING (the
    // real defect this guard exists to name) still outlives every attempt and still fails below,
    // with the reason.
    const deadline = Date.now() + 5_000;
    let remaining = await countSessions();
    while (remaining > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      remaining = await countSessions();
    }

    if (remaining !== 0) {
      throw new Error(
        `db-server: ABORT — ${remaining} session(s) still hold template '${TEMPLATE_DATABASE}' ` +
          '5s after being terminated, so every CREATE DATABASE … TEMPLATE will fail with ' +
          '"There is N other session using the database".\n' +
          'Something is RECONNECTING to the template. The template is migrated ONCE and must ' +
          'never be connected to again — not for a health check, not for a quick verify, not ' +
          'for codegen (task 73). Look for a pool whose connectionString names ' +
          `'${TEMPLATE_DATABASE}'.`,
      );
    }
  });
}

/**
 * Proves the container's real `max_connections` can fund the parallelism VITEST ACTUALLY
 * CONFIGURED — not the parallelism this module would like to believe it configured.
 *
 * @param actualMaxWorkers the worker count read from the live vitest config at boot. It is a
 *   REQUIRED argument, and that is the whole point of this function's shape.
 *
 * A guard must assert its own denominator (T-14), and the first version of this one did not.
 * It compared `MAX_PARALLEL_FILES` — its OWN constant — against the server, so it answered
 * "is the number I chose self-consistent?" while claiming to answer "can this run fit?".
 * review-73 falsified it: `maxWorkers: 110` left the guard GREEN (24 × 2 + 10 ≤ 197) while the
 * run opened 220 connections. Both facts were true and the guard was blind to the one that
 * mattered, which is §2.11's whole thesis — a guard whose failure mode is "silently checks
 * nothing" converts an unknown risk into a false assurance.
 *
 * Taking the real number as a parameter is what closes it BY CONSTRUCTION: there is no longer a
 * value this function can check that is not the value the run will use.
 */
export async function assertConnectionBudget(
  maintenanceUri: string,
  actualMaxWorkers: number,
): Promise<void> {
  if (!Number.isInteger(actualMaxWorkers) || actualMaxWorkers < 1) {
    throw new Error(
      `db-server: ABORT — could not read vitest's real maxWorkers (got ${JSON.stringify(actualMaxWorkers)}).\n` +
        'This guard exists to compare the LIVE worker count against the LIVE server. Defaulting ' +
        'it would make the check pass by assuming its own answer (T-19), which is the exact ' +
        'defect review-73 found here.',
    );
  }

  await withAdmin(maintenanceUri, async (client) => {
    const { rows } = await client.query<{ name: string; setting: string }>(
      `SELECT name, setting FROM pg_settings
        WHERE name IN ('max_connections', 'superuser_reserved_connections')`,
    );
    const settings = new Map(rows.map((r) => [r.name, Number(r.setting)]));
    const max = settings.get('max_connections');
    const reserved = settings.get('superuser_reserved_connections');
    if (max === undefined || reserved === undefined) {
      throw new Error('db-server: could not read max_connections from the container');
    }

    const budget = actualMaxWorkers * POOL_PER_FILE + HEADROOM;
    const available = max - reserved;
    if (budget > available) {
      throw new Error(
        `db-server: ABORT — connection budget does not fit.\n` +
          `  ${actualMaxWorkers} workers × ${POOL_PER_FILE} conns + ${HEADROOM} headroom = ${budget}\n` +
          `  available = max_connections(${max}) − superuser_reserved(${reserved}) = ${available}\n` +
          'Lower maxWorkers in vitest.config.ts (MAX_PARALLEL_FILES in src/testing/budget.ts), ' +
          'or shard to a second container. Raising max_connections costs a process + work_mem ' +
          'per backend (task 73). Measured: exceeding the real ceiling gives `sorry, too many ' +
          'clients already` (53300) in ~1.1s — an attributable error, not a wedge.',
      );
    }
  });
}

/**
 * Asserts a database belongs to THIS run, by its stamp. Fails CLOSED on an absent stamp.
 *
 * An unstamped database is treated as foreign on purpose: "unstamped" is indistinguishable from
 * "somebody else's", and adopting it is the exact bug T-14d records. This NEVER writes a stamp —
 * provisioning and verification stay separate, or a foreign database gets adopted by the very
 * check meant to reject it (db-lane.mjs's rule, kept verbatim in spirit).
 */
export async function assertAttribution(uri: string, expectedOwner: string): Promise<string> {
  const pool = new pg.Pool({ connectionString: uri, max: 1, allowExitOnIdle: true });
  try {
    const { rows } = await pool.query<{ owner: string | null; database: string; version: string }>(
      `SELECT current_setting('${DB_OWNER_SETTING}', true) AS owner,
              current_database() AS database,
              current_setting('server_version') AS version`,
    );
    const row = rows[0];
    if (row === undefined) throw new Error('db-server: attribution query returned no rows');

    if (row.owner === null || row.owner === '') {
      throw new Error(
        `db-server: ABORT — database '${row.database}' carries no ${DB_OWNER_SETTING} stamp, so ` +
          `it cannot be shown to belong to run '${expectedOwner}' (T-14d).`,
      );
    }
    if (row.owner !== expectedOwner) {
      throw new Error(
        `db-server: ABORT — WRONG DATABASE. '${row.database}' belongs to run '${row.owner}', ` +
          `but this run is '${expectedOwner}'. A green whose provenance is unknown is not a ` +
          'green (T-14d).',
      );
    }
    return `PostgreSQL ${row.version} · db '${row.database}' · owned by '${row.owner}'`;
  } finally {
    await pool.end();
  }
}

/** A deterministic, collision-free database name for a test file. */
export function databaseNameFor(testPath: string): string {
  // Deterministic so a failure is reproducible from the name alone (task 73: "state the sharding
  // key and make it deterministic"). FNV-1a over the repo-relative path — not a random id, which
  // would make the same file produce a different database every run.
  let hash = 0x811c9dc5;
  for (let i = 0; i < testPath.length; i += 1) {
    hash ^= testPath.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const base = testPath.replace(/^.*\//, '').replace(/\.test\.[cm]?tsx?$/, '');
  const safe = base
    .replace(/[^a-z0-9]+/gi, '_')
    .toLowerCase()
    .slice(0, 32);
  return `t_${safe}_${hash.toString(36)}`;
}

/** `postgres://…/<database>` for this container, derived from the container we started. */
export function uriForDatabase(container: StartedPostgreSqlContainer, database: string): string {
  const base = container.getConnectionUri();
  return base.replace(/\/[^/?]*(\?|$)/, `/${database}$1`);
}

/** One short-lived admin connection. Always closed — a leak here breaks every later clone. */
async function withAdmin<T>(uri: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: uri });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Identifier quoting for the few DDL statements that cannot take a bound parameter. */
function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`db-server: refusing to interpolate unsafe identifier '${name}'`);
  }
  return `"${name}"`;
}

/** Literal quoting for `ALTER DATABASE … SET`, which cannot take a bound parameter either. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// =================================================================================================
// THE CONSUMER-FACING SEAM — the ONE place `pg` becomes a `Kysely<DB>` (task 81)
// -------------------------------------------------------------------------------------------------
// task 73 shipped the container/template/clone machinery above and exported it under `./testing`,
// but it exported ZERO `Kysely`: db-server's own harness (`test/helpers/test-db.ts`) turned a URI
// into a handle with its OWN `import pg from 'pg'` + `new pg.Pool(...)` + `CamelCasePlugin`. That is
// exactly the line `apps/server` may not write — `pg` is boundary-locked to this package (08 §3.3).
//
// So the factory that owns clone + stamp-assertion + `pg.Pool` + `CamelCasePlugin` lives HERE, once
// (CLAUDE.md §2.8), and is imported by BOTH db-server's harness and apps/server's — which reach a
// real PG16 database WITHOUT importing `pg`, because this seam holds the only `pg.Pool` construction
// a test's Kysely is built on. `pg` never leaves db-server; the boundary ruling is discharged by
// this code, not asserted by a comment (task 81, correcting the earlier "hands apps/server a
// Kysely<DB>" claim that had no producer — T-16).

/** Serializable lane coordinates a test file needs to clone and connect. Provided by globalSetup. */
export interface TestLaneCoords {
  /** Maintenance-database URI — `CREATE DATABASE … TEMPLATE` is issued from here, never the template. */
  readonly maintenanceUri: string;
  /** Base URI whose database component each file swaps for its own clone. */
  readonly baseUri: string;
  /** The token every database of this run is stamped with (T-14d). */
  readonly owner: string;
}

/** Options a consumer may pass through to the underlying Kysely handle. */
export interface CreateTestDatabaseOptions {
  /** Receives every SQL string Kysely executes, in order (for statement-ordering / FOR UPDATE spies). */
  readonly onQuery?: (sql: string) => void;
}

/** A per-file database handle plus the provenance line proving WHICH database answered (T-14d). */
export interface TestDatabaseHandle {
  readonly db: Kysely<DB>;
  /** `assertAttribution`'s return: "PostgreSQL 16.14 … db '<clone>' … owned by '<run>'". */
  readonly provenance: string;
  readonly close: () => Promise<void>;
}

/**
 * Per-process monotonic counter, appended to each clone's file-derived name so repeated calls in
 * one file (per-test harnesses) do not collide on `CREATE DATABASE`. Per-worker because vitest runs
 * each test file in one worker; the file-name prefix keeps every name traceable to its source file.
 */
let cloneSequence = 0;

/**
 * Clones this test file's OWN database from the pre-migrated template, asserts it belongs to THIS
 * run, and returns a `Kysely<DB>` over it. The single construction of `pg.Pool` + `CamelCasePlugin`
 * for every L3 test in the repo — db-server's and apps/server's alike.
 *
 * `testPath` is the file's own identity (`expect.getState().testPath`). It is REQUIRED and rejected
 * when absent: a default would manufacture a plausible database name from a failed read, and two
 * files that both failed the read would then SHARE a database — the cross-file interference this
 * design exists to remove, resurfacing as an irreproducible flake (T-19, task 73's own rule).
 *
 * EACH CALL gets a FRESH database, not each file. db-server's harness clones once per file
 * (`beforeAll`), but apps/server's suites clone per test (`beforeEach` + `close()` in `afterEach`)
 * — the shape the PGlite harness had, kept unchanged so no test file is rewritten. So the clone
 * name is the file identity (the traceable prefix a failure names) PLUS a per-process counter that
 * makes repeated calls in one file collision-free; without it the second `beforeEach` clone would
 * fail `CREATE DATABASE … already exists`. A clone is a filesystem copy (milliseconds) — cheaper
 * than the WASM-boot-plus-migrate PGlite paid per test — and the container is ephemeral, so the
 * extra per-test databases are reaped with it (Ryuk).
 */
export async function createTestDatabase(
  lane: TestLaneCoords,
  testPath: string | undefined,
  options: CreateTestDatabaseOptions = {},
): Promise<TestDatabaseHandle> {
  if (testPath === undefined || testPath === '') {
    throw new Error(
      'db-server: cannot resolve this test file path, so its database name would not be unique. ' +
        'Two files sharing a database is the interference this lane exists to remove (task 73). ' +
        'Pass expect.getState().testPath — do NOT default it (T-19).',
    );
  }

  cloneSequence += 1;
  const database = `${databaseNameFor(testPath)}_${cloneSequence.toString(36)}`;
  await createDatabaseFromTemplate({ maintenanceUri: lane.maintenanceUri }, database, lane.owner);

  const uri = lane.baseUri.replace(/\/[^/?]*(\?|$)/, `/${database}$1`);

  // Attribution is asserted per file, on the exact connection string the test's pool will use — a
  // guard that verifies a DIFFERENT connection from the one under test is theatre. Fails CLOSED on
  // an absent stamp.
  const provenance = await assertAttribution(uri, lane.owner);

  const db = new Kysely<DB>({
    dialect: new PostgresDialect({
      // `allowExitOnIdle` so an idle pool NEVER keeps its worker alive. vitest runs each file in a
      // fork worker and waits (via the IPC pipe) for it to exit; a pg pool whose last connection is
      // idle otherwise pins the worker's event loop, so the worker never exits and the whole run
      // HANGS after "Test Files N passed" (task 81 — measured: the sole referenced handle in a hung
      // run was that IPC pipe). `close()`/`db.destroy()` still ends the pool explicitly per test;
      // this is the belt to that braces, covering any path that resolves without a matching close.
      pool: new pg.Pool({ connectionString: uri, max: POOL_PER_FILE, allowExitOnIdle: true }),
    }),
    plugins: [createCamelCasePlugin()],
    // exactOptionalPropertyTypes (08 §4.1): `log: undefined` is a type error, so the key must be
    // ABSENT rather than undefined when no spy is wanted.
    ...(options.onQuery === undefined
      ? {}
      : { log: (event) => options.onQuery?.(event.query.sql) }),
  });

  return { db, provenance, close: () => db.destroy() };
}

/**
 * Migrates the template ONCE — the only code permitted to open a connection to the template.
 *
 * `db.destroy()` in the finally is not politeness: a surviving connection makes every later
 * `CREATE DATABASE … TEMPLATE` fail with "There is 1 other session using the database", and
 * `assertTemplateUnused` (run immediately after `startPgLane` calls this) is the backstop that
 * turns a leak into a loud, attributed error rather than a distant one.
 *
 * It lives in the seam so a consumer's globalSetup (apps/server's) never constructs a `pg.Pool`
 * to run migrations — the same boundary reason `createTestDatabase` exists (§2.8).
 */
export async function migrateTemplate(templateUri: string): Promise<void> {
  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: templateUri, max: 1, allowExitOnIdle: true }),
    }),
  });
  try {
    await migrateToLatest(db as never);
  } finally {
    await db.destroy();
  }
}

// =================================================================================================
// THE SHARED globalSetup — ONE lane bring-up, reused by every project that runs L3 (task 81, §2.8)
// -------------------------------------------------------------------------------------------------
// db-server and apps/server each get their OWN container (vitest `provide` is per-project, so two
// projects cannot share provided values, and each project's connection budget must be checked
// against its OWN live maxWorkers — the review-73 fix that a root-level, project-blind setup could
// not preserve). But the bring-up itself — boot, migrate-once, assert-attribution, provide, log —
// is identical, so it lives here once and each project's globalSetup is a two-line delegation.
//
// The `ProvidedContext` augmentation for `inject('pgMaintenanceUri' | 'pgOwner' | 'pgBaseUri')`
// canNOT live in this file: it is `src`, where `vitest` is not resolvable (it is a test-only
// devDep). It lives in each project's globalSetup — where vitest IS in scope and the augmentation
// naturally sits — and the keys below are plain string literals, so this seam needs no vitest types.

/**
 * The structural shape of the `project` argument vitest hands a globalSetup. Deliberately NOT
 * vitest's `TestProject` import: the seam stays runtime-free of vitest, and this names only the two
 * members the bring-up reads — `provide` (to publish the lane) and `config.maxWorkers` (the LIVE
 * parallelism the budget must be checked against).
 */
export interface LaneGlobalSetupProject {
  readonly name?: string;
  provide: <K extends 'pgMaintenanceUri' | 'pgOwner' | 'pgBaseUri'>(key: K, value: string) => void;
  readonly config?: { readonly maxWorkers?: unknown };
}

/**
 * The worker count VITEST ACTUALLY RESOLVED, read from the live project config — NOT a constant.
 *
 * review-73 proved this distinction IS the guard: when the budget check compared its own constant,
 * `maxWorkers: 110` sailed through (24 × 2 + 10 ≤ 197) while the run opened 220 connections. It
 * THROWS rather than defaulting: a `?? MAX_PARALLEL_FILES` would resurrect that exact defect, and a
 * default plausible in the domain is indistinguishable from a real reading (T-19).
 */
export function resolveMaxWorkers(project: LaneGlobalSetupProject): number {
  const raw = project.config?.maxWorkers;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  throw new Error(
    `db-server: ABORT — vitest's resolved maxWorkers is ${JSON.stringify(raw)}, not a positive ` +
      'integer, so the connection budget cannot be checked against the parallelism this run will ' +
      'actually use.\n' +
      'vitest.config.ts must set `maxWorkers` to a number (import MAX_PARALLEL_FILES from ' +
      '@bolusi/db-server/testing). Refusing rather than assuming: a guard that assumes its own ' +
      'answer is the defect review-73 found (task 73).',
  );
}

/**
 * Boots one container, migrates the template once, asserts THIS run owns it, and publishes the lane
 * to the project's tests. Returns a teardown that stops the container (Ryuk is the guarantee; this
 * is the fast path). Every project's globalSetup is just `teardown = await setupPgLane(project)`.
 */
export async function setupPgLane(project: LaneGlobalSetupProject): Promise<() => Promise<void>> {
  const started = Date.now();
  const maxWorkers = resolveMaxWorkers(project);

  const lane = await startPgLane(migrateTemplate, maxWorkers);

  const provenance = await assertAttribution(
    uriForDatabase(lane.container, TEMPLATE_DATABASE),
    lane.owner,
  );

  project.provide('pgMaintenanceUri', lane.maintenanceUri);
  project.provide('pgOwner', lane.owner);
  project.provide('pgBaseUri', lane.container.getConnectionUri());

  // Provenance, printed on every run: which database produced the numbers that follow (§2.1). The
  // template is stamped and verified BEFORE any clone, so every clone inherits a checked stamp.
  const label = project.name ?? 'db';
  console.log(
    `${label}: lane UP in ${Date.now() - started}ms — ${provenance} · template ` +
      `'${TEMPLATE_DATABASE}' migrated once · budget OK for ${maxWorkers} live workers`,
  );

  return async () => {
    // Best-effort. Ryuk is the guarantee — if this process is SIGKILLed, teardown never runs and
    // Ryuk reaps the container anyway (the structural argument for testcontainers, task 73).
    await lane.container.stop();
  };
}
