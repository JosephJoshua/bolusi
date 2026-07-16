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
import pg from 'pg';

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
    .withCommand(['postgres', '-c', `max_connections=${MAX_CONNECTIONS}`])
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
  const pool = new pg.Pool({ connectionString: uri, max: 1 });
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
