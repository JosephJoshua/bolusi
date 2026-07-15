// The one test harness, run against BOTH engines (08-stack-and-repo §5.4: "the identical suite
// re-runs against real Postgres"; testing-guide §2.5.4: "PGlite is the fast loop, real Postgres
// is the drift check"). Engine is chosen by env, never by a forked copy of the suite.
//
//   pnpm test      → PGlite   (in-process, no docker)
//   pnpm test:rls  → Postgres 16 in docker (CI stage 9 merge gate)
//
// The drift this guards is real, not theoretical: PGlite 0.5.4 embeds PostgreSQL 18, while
// production and `pnpm test:rls` pin Postgres 16.
import { Kysely, PGliteDialect, PostgresDialect, sql, type KyselyConfig } from 'kysely';
import pg from 'pg';

import { createCamelCasePlugin } from '../../src/camel-case.js';
import { createForTenant, type ForTenant } from '../../src/for-tenant.js';
import type { DB } from '../../src/generated/db.js';
import { migrateToLatest } from '../../src/migrator.js';
import { APP_ROLE } from '../../src/schema/security.js';
import { ENGINE, postgresUrl } from './db-target.js';

export { ENGINE, type Engine } from './db-target.js';

export interface TestDbOptions {
  /** Receives every SQL string Kysely executes, in order (for the set_config ordering test). */
  onQuery?: (sql: string) => void;
  /** Skip migrations — the migration suite drives the migrator itself. */
  skipMigrations?: boolean;
}

export interface TestDb {
  /**
   * Owner/superuser handle. Seeding goes through this — it bypasses RLS, which is exactly what
   * a fixture needs and exactly what a PROBE must never use (see `appForTenant`).
   */
  readonly db: Kysely<DB>;
  /**
   * The probe path: `forTenant` that runs `SET LOCAL ROLE bolusi_app` inside the transaction.
   *
   * testing-guide §2.5 is blunt about why this exists: PGlite connects as the superuser and
   * superusers bypass RLS, so an RLS suite that skips SET ROLE passes VACUOUSLY and proves
   * nothing. Every tenant-isolation assertion in this package goes through THIS handle.
   * `sec-tenant-02` additionally proves the harness is not vacuous, by showing the owner
   * handle CAN see across tenants while this one cannot.
   */
  readonly appForTenant: ForTenant;
  /** `forTenant` WITHOUT the role switch — the production statement shape. */
  readonly ownerForTenant: ForTenant;
  readonly close: () => Promise<void>;
}

/**
 * Builds a migrated database on the configured engine. Caller owns `close()`.
 *
 * Every test file gets its own: on PGlite that is a fresh in-memory postgres; on the real
 * engine it is a schema reset. Files are serialised (`fileParallelism: false`) so the reset
 * cannot race a neighbour.
 */
export async function createTestDb(options: TestDbOptions = {}): Promise<TestDb> {
  const db = ENGINE === 'pglite' ? await createPglite(options) : await createPostgres(options);

  if (options.skipMigrations !== true) {
    await migrateToLatest(db);
  }

  return {
    db,
    appForTenant: createForTenant(db, { role: APP_ROLE }),
    ownerForTenant: createForTenant(db),
    close: () => db.destroy(),
  };
}

/**
 * The `log` half of a Kysely config, or nothing at all.
 *
 * Returned as a spreadable object rather than a possibly-undefined value because the repo runs
 * `exactOptionalPropertyTypes` (08 §4.1): passing `log: undefined` explicitly is a type error,
 * so the key has to be absent, not undefined.
 */
function kyselyLog(options: TestDbOptions): Pick<KyselyConfig, 'log'> | Record<string, never> {
  const { onQuery } = options;
  if (onQuery === undefined) return {};
  return {
    log: (event) => {
      onQuery(event.query.sql);
    },
  };
}

async function createPglite(options: TestDbOptions): Promise<Kysely<DB>> {
  // Imported lazily so the postgres lane never pays for the WASM boot.
  const { PGlite } = await import('@electric-sql/pglite');
  const pglite = new PGlite();
  await pglite.waitReady;

  return new Kysely<DB>({
    dialect: new PGliteDialect({ pglite }),
    plugins: [createCamelCasePlugin()],
    ...kyselyLog(options),
  });
}

async function createPostgres(options: TestDbOptions): Promise<Kysely<DB>> {
  // Resolved per call, and from the same module the attribution gate reads (db-target.ts), so
  // the database this harness opens is provably the one global-setup verified (T-14d).
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: postgresUrl() }) }),
    plugins: [createCamelCasePlugin()],
    ...kyselyLog(options),
  });

  // Fresh schema per file so migrations are exercised from zero every time.
  //
  // The ROLES are deliberately NOT dropped: they are cluster-wide and own objects in the dev
  // database too, so dropping them here would fail. That is precisely the case 0001's
  // idempotent DO blocks exist for — this reset re-runs 0001 against pre-existing roles on
  // every run, so their idempotency is continuously proven rather than asserted.
  await sql`DROP SCHEMA IF EXISTS public CASCADE`.execute(db);
  await sql`CREATE SCHEMA public`.execute(db);

  return db;
}
