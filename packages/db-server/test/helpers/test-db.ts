// The one test harness. Real PostgreSQL 16, in a container, over the real `pg` driver (D16/73).
//
// WHAT CHANGED AND WHY IT MATTERS
// --------------------------------
// This used to pick an engine from `BOLUSI_DB_ENGINE`: PGlite for the fast loop, real Postgres
// for the drift check (testing-guide §2.5.4, now superseded). D16 removed the choice, and the
// repo's own measurements are why — reproduced a third time by task 73, on this exact file's
// subject:
//
//   int8 seam reverted at `reconstructOperation`, same test file, same assertions:
//     PGlite                 14/14 GREEN  EXIT=0   ← blind
//     real PG16 over `pg`     4 RED       EXIT=1   ← `expected [ '10', '9' ] to equal [ 9, 10 ]`
//
// A "fast loop / drift check" split cannot help when the fast loop is green BECAUSE it cannot see
// the defect. There is one lane now, and it is the real one.
//
// EACH FILE OWNS A DATABASE — WHICH IS WHY `fileParallelism` IS BACK ON
// ---------------------------------------------------------------------
// The old postgres path did `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` + a full migrate,
// against ONE shared database. That is why this package set `fileParallelism: false`: the reset
// would race a neighbour. The PGlite path was no better — it booted a WASM Postgres AND migrated,
// per file, which is what made parallel files "contend on CPU and time out".
//
// Both reasons are gone. `CREATE DATABASE … TEMPLATE <pre-migrated>` is a filesystem-level copy:
// no WASM boot, no migrate, milliseconds. Each file gets a private database, so there is nothing
// left to race and nothing left to serialise for.
import { sql, type Kysely } from 'kysely';
import { expect, inject } from 'vitest';

import { createForTenant, type ForTenant } from '../../src/for-tenant.js';
import type { DB } from '../../src/generated/db.js';
import { APP_ROLE } from '../../src/schema/security.js';
import { createTestDatabase } from '../../src/testing/pg-container.js';

/**
 * The lane identifier the suites report in their T-14 "which engine answered" assertions.
 *
 * The UNION is kept deliberately even though only one member is now reachable: these tests exist
 * to make the lane EXPLICIT rather than assumed (T-14f rule 3 — "when a gate's name says Postgres,
 * write down which Postgres and over which client"), and a gate that can only express one answer
 * has stopped asking the question. `ENGINE` is now a constant because D16 removed the choice, not
 * because the question stopped mattering.
 *
 * Note what this un-skips: `oplog-server-seq-concurrency.test.ts` guards its genuinely concurrent
 * cases with `describe.runIf(ENGINE === 'postgres')`, so on the PGlite lane they SILENTLY DID NOT
 * RUN — a green with a smaller denominator than it looked (T-14). They now always run.
 */
export type Engine = 'pglite' | 'postgres';

/** D16: there is one L3 DB engine, and it is real PostgreSQL 16 over the real `pg` driver. */
export const ENGINE: Engine = 'postgres';

export interface TestDbOptions {
  /** Receives every SQL string Kysely executes, in order (for the set_config ordering test). */
  onQuery?: (sql: string) => void;
  /** Skip migrations — kept for the migration suite, which drives the migrator itself. */
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
   * THE ROLE IS WHAT MAKES THIS LANE NON-VACUOUS — NOT THE ENGINE. Moving off PGlite does not by
   * itself fix T-14b: testcontainers' default `postgres` user is a SUPERUSER, and a superuser
   * bypasses RLS even under FORCE ROW LEVEL SECURITY. (The table OWNER does not bypass here —
   * `secureTenantTable` FORCEs RLS and hands ownership to `bolusi_provision` — so the superuser
   * is the only bypass left, and this role switch is what closes it.) Connecting a container as
   * `postgres` and calling it a real-PG RLS lane would swap one vacuous lane for another; D16
   * says so in as many words. Every tenant-isolation assertion goes through THIS handle, and
   * `sec-tenant-02` proves the harness is not vacuous by showing the owner handle CAN see across
   * tenants while this one cannot.
   */
  readonly appForTenant: ForTenant;
  /** `forTenant` WITHOUT the role switch — the production statement shape. */
  readonly ownerForTenant: ForTenant;
  readonly close: () => Promise<void>;
}

/**
 * Builds this test file's OWN database, cloned from the pre-migrated template. Caller owns
 * `close()`.
 *
 * The clone is named deterministically from the test path, so a failure names the file that
 * produced it (task 73) rather than a random id nobody can trace back.
 */
export async function createTestDb(options: TestDbOptions = {}): Promise<TestDb> {
  // The clone + stamp assertion + `pg.Pool` + `CamelCasePlugin` are the seam's `createTestDatabase`
  // (task 81, §2.8) — the ONE place a test's `Kysely<DB>` is built on a real `pg` pool. This helper
  // adds only what is db-server-specific: the forTenant wrappers and the migration suite's empty-DB
  // path. The file identity comes from vitest's own state (the same string vitest prints in a
  // failure), and `createTestDatabase` rejects an absent path rather than defaulting it (T-19).
  const handle = await createTestDatabase(
    {
      maintenanceUri: inject('pgMaintenanceUri'),
      baseUri: inject('pgBaseUri'),
      owner: inject('pgOwner'),
    },
    expect.getState().testPath,
    options.onQuery === undefined ? {} : { onQuery: options.onQuery },
  );
  const { db } = handle;

  if (options.skipMigrations === true) {
    // The migration suite drives the migrator from zero itself, so hand it an EMPTY database
    // rather than the template's fully-migrated schema. Dropping the schema is safe here in a way
    // it never was before: this database belongs to this file alone.
    await sql`DROP SCHEMA public CASCADE`.execute(db);
    await sql`CREATE SCHEMA public`.execute(db);
    // 0001's roles are cluster-wide and survive the drop, which is exactly the case its
    // idempotent DO blocks exist for — so their idempotency stays continuously proven.
  }

  return {
    db,
    appForTenant: createForTenant(db, { role: APP_ROLE }),
    ownerForTenant: createForTenant(db),
    close: handle.close,
  };
}
