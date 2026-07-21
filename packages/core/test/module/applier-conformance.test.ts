// THE BOTH-ENGINE RULE (testing-guide T-8 / §2.4; 04-module-contract §2) — the stage-10 merge gate
// (`pnpm test:appliers`).
//
// 04 §2: appliers are written against a `ProjectionDb` restricted to a DIALECT-NEUTRAL subset, and
// that restriction is "enforced by review + shared test suite that runs every applier against both
// engines". T-8 makes it a merge gate: "a module without this suite passing does not merge."
//
// WHY IT MATTERS BEYOND TIDINESS. The same appliers run on the device (SQLite) and on the server
// (Postgres) over the same op history. If they disagree — a dialect-specific function, an integer
// that comes back as a string, a boolean stored as `1` on one side and `true` on the other — then a
// device and the server hold DIFFERENT ANSWERS derived from identical, signed, hash-chained ops.
// Nothing else in the system would notice: both sides are internally consistent, both sync happily,
// and the divergence surfaces as a user saying "the total is different on my phone".
//
// THIS RUNNER injects the drivers (better-sqlite3 for SQLite, PGlite for Postgres); the shared
// procedure lives in `@bolusi/test-support`, which imports no driver (08 §3.3 hard rule 2). PGlite
// embeds a real PostgreSQL, so the Postgres leg is a real Postgres, not an emulation.
import { CamelCasePlugin, Kysely, PGliteDialect, sql } from 'kysely';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, test } from 'vitest';

import { createClientDialect } from '@bolusi/db-client';
import type { SignedOperation } from '@bolusi/schemas';
import {
  makeFixtureModuleManifest,
  mulberry32,
  noblePort,
  runApplierConformance,
  FIXTURE_TABLE,
  type FixtureDatabase,
} from '@bolusi/test-support';

import {
  decodeCursor,
  defineModule,
  encodeCursor,
  type AnyModuleDefinition,
} from '../../src/index.js';
import { openMemoryDriver } from '../projection/better-sqlite3-driver.js';

/**
 * The MINIMAL op-log + watermark DDL the projection engine reads (04 §4.2/§4.3).
 *
 * NOT a copy of the real schema and not a second source of truth for it: the engine's reads are
 * dialect-neutral raw SQL over a handful of `operations` columns (projection/oplog-source.ts) plus
 * the watermark table, and this is exactly that surface and nothing else. The real DDL is owned by
 * db-client (SQLite, 10-db §9) and db-server (Postgres) — neither of which this suite can reach on
 * BOTH engines at once: db-client's migrations are SQLite-only, and `@bolusi/core` may not import
 * db-server (08 §3.3). REPORTED for task 33 as a candidate to fold into a shared test-only schema
 * once one exists.
 *
 * TYPES: ms-epoch and seq columns are `bigint`, NOT `integer` — Postgres `integer` is 32-bit and
 * an ms-epoch timestamp (1.7e12) overflows it, while SQLite's INTEGER is 64-bit and swallows it
 * silently. That asymmetry is not hypothetical: this suite's first run failed with
 * `value "1726000000587" is out of range for type integer` on the Postgres leg while SQLite was
 * perfectly happy — which is precisely the class of divergence T-8 exists to catch, found by the
 * gate on its very first execution. db-server's own DDL agrees (`created_at bigint`, 0005).
 */
async function createOpLogTables(db: Kysely<never>): Promise<void> {
  await db.schema
    .createTable('operations')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull())
    .addColumn('store_id', 'text')
    .addColumn('user_id', 'text', (c) => c.notNull())
    .addColumn('device_id', 'text', (c) => c.notNull())
    .addColumn('seq', 'bigint', (c) => c.notNull())
    .addColumn('type', 'text', (c) => c.notNull())
    .addColumn('entity_type', 'text', (c) => c.notNull())
    .addColumn('entity_id', 'text', (c) => c.notNull())
    .addColumn('schema_version', 'integer', (c) => c.notNull())
    .addColumn('payload', 'text', (c) => c.notNull())
    .addColumn('timestamp_ms', 'bigint', (c) => c.notNull())
    .addColumn('location', 'text')
    .addColumn('source', 'text', (c) => c.notNull())
    .addColumn('agent_initiated', 'integer', (c) => c.notNull())
    .addColumn('agent_conversation_id', 'text')
    .addColumn('previous_hash', 'text')
    .addColumn('hash', 'text', (c) => c.notNull())
    .addColumn('signature', 'text', (c) => c.notNull())
    .addColumn('signed_core_jcs', 'text', (c) => c.notNull())
    .addColumn('sync_status', 'text', (c) => c.notNull())
    .addColumn('arrival_seq', 'bigint')
    .addColumn('synced_at', 'bigint')
    .execute();

  // Column names and defaults match db-client's `001-initial-schema.ts` VERBATIM (10-db §9.1).
  // `DEFAULT 0` is load-bearing, not decoration: `createSqlWatermarkStore`'s upsert inserts only
  // ONE of the two seq columns per call, so the other must default rather than violate NOT NULL.
  // (A first pass at this DDL guessed `projection` for the key column and `NOT NULL` without a
  // default; both failed loudly against the real store — which is the argument for reading the
  // schema instead of remembering it.)
  await db.schema
    .createTable('projection_watermarks')
    .addColumn('module_id', 'text', (c) => c.primaryKey())
    .addColumn('applied_server_seq', 'bigint', (c) => c.notNull().defaultTo(0))
    .addColumn('applied_local_seq', 'bigint', (c) => c.notNull().defaultTo(0))
    .execute();

  // `meta_kv` — the rebuild cursor's home (projection/rebuild.ts). The engine touches it on the
  // rebuild path only, but the table must exist for the store to bind against.
  await db.schema
    .createTable('meta_kv')
    .addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('value', 'text', (c) => c.notNull())
    .execute();
}

/** A deterministic op script for the fixture module (T-6: reproduces bit-for-bit per seed). */
function generateScript(seed: number, count: number): SignedOperation[] {
  const prng = mulberry32(seed);
  const ops: SignedOperation[] = [];
  let timestamp = 1_726_000_000_000;

  for (let i = 0; i < count; i += 1) {
    timestamp += 1 + Math.floor(prng() * 1_000);
    ops.push({
      id: `op-${seed}-${String(i).padStart(4, '0')}`,
      tenantId: `tenant-${seed}`,
      storeId: `store-${seed}`,
      userId: `user-${seed}-${i % 3}`,
      deviceId: `dev-${seed}-${i % 2}`,
      seq: i + 1,
      type: 'fixture.item_created',
      entityType: 'fixture_item',
      entityId: `item-${seed}-${i}`,
      schemaVersion: 1,
      payload: {
        label: `label-${seed}-${i}`,
        // Deliberately awkward text: quotes, a newline, non-ASCII and an emoji. Text handling is
        // where SQLite and Postgres most plausibly diverge, and a digest over ASCII-only labels
        // would never notice.
        secretNote: `secret'"${seed}\n${i} — ünïcode ✓`,
      } as unknown as SignedOperation['payload'],
      timestamp,
      location: null,
      source: 'ui',
      agentInitiated: false,
      agentConversationId: null,
      previousHash: '0'.repeat(64),
      hash: String(i + 1).padStart(64, '0'),
      signature: `sig-${seed}-${i}`,
    });
  }
  return ops;
}

/** Insert an op into the minimal op-log table. Dialect-neutral. */
async function insertOp(db: Kysely<never>, op: SignedOperation): Promise<void> {
  await sql`
    INSERT INTO operations (
      id, tenant_id, store_id, user_id, device_id, seq, type, entity_type, entity_id,
      schema_version, payload, timestamp_ms, location, source, agent_initiated,
      agent_conversation_id, previous_hash, hash, signature, signed_core_jcs, sync_status,
      arrival_seq, synced_at
    ) VALUES (
      ${op.id}, ${op.tenantId}, ${op.storeId}, ${op.userId}, ${op.deviceId}, ${op.seq}, ${op.type},
      ${op.entityType}, ${op.entityId}, ${op.schemaVersion}, ${JSON.stringify(op.payload)},
      ${op.timestamp}, ${null}, ${op.source}, ${op.agentInitiated ? 1 : 0}, ${null},
      ${op.previousHash}, ${op.hash}, ${op.signature}, ${`jcs:${op.id}`}, ${'local'}, ${null}, ${null}
    )
  `.execute(db);
}

async function countFixtureRows(db: Kysely<never>): Promise<number> {
  const result = await sql<{
    c: number | string;
  }>`SELECT COUNT(*) AS c FROM ${sql.table(FIXTURE_TABLE)}`.execute(db);
  return Number(result.rows[0]?.c ?? 0);
}

function fixtureModule(): AnyModuleDefinition<never> {
  const manifest = makeFixtureModuleManifest({ encodeCursor, decodeCursor });
  return defineModule<FixtureDatabase, typeof manifest>(
    manifest,
  ) as unknown as AnyModuleDefinition<never>;
}

/** A fresh SQLite + Postgres pair, schema'd and ready. */
async function openEngines(): Promise<{
  sqliteDb: Kysely<never>;
  pgDb: Kysely<never>;
  close: () => Promise<void>;
}> {
  // ── SQLite: better-sqlite3 :memory: behind the SHIM DIALECT (testing-guide §2.3) ──────────────
  // The shim is the point: op-sqlite cannot run in Node, so CI drives the identical Kysely dialect
  // layer over a different driver. Testing raw better-sqlite3 here would prove nothing about the
  // device.
  const driver = openMemoryDriver();
  const sqliteDb = new Kysely<never>({
    dialect: createClientDialect(driver),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });

  // ── Postgres: PGlite via Kysely's IN-CORE PGliteDialect (testing-guide §2.1 L3 names it) ──────
  // PGlite 0.5.4 embeds PostgreSQL 18, so this leg is a real Postgres parser/planner/type system.
  const pglite = new PGlite();
  const pgDb = new Kysely<never>({
    dialect: new PGliteDialect({ pglite }),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });

  for (const db of [sqliteDb, pgDb]) {
    await createOpLogTables(db);
    for (const migration of fixtureModule().projections.migrations ?? []) {
      await migration.up(db as never);
    }
  }

  return {
    sqliteDb,
    pgDb,
    close: async () => {
      await sqliteDb.destroy();
      await driver.close();
      // `pgDb.destroy()` closes the underlying PGlite — the in-core dialect owns its lifecycle. An
      // extra `pglite.close()` throws "PGlite is closed", which vitest reports as a FAILED SUITE
      // while every test inside passes (3 passed, EXIT=1). Worth naming: the test count said green
      // and only the exit code was right (CLAUDE.md §2.1).
      await pgDb.destroy();
    },
  };
}

/**
 * A pair per test rather than one shared pair.
 *
 * The divergence test below deliberately corrupts one engine's projection, and a shared pair would
 * leak that corruption into whichever test ran next — a cross-test dependency that presents as
 * flakiness (T-10) rather than as the coupling it is.
 */
describe('applier conformance: SQLite vs Postgres (T-8 / 04 §2)', () => {
  test('the same op script folds to byte-identical oracle digests on both engines', async () => {
    const engines = await openEngines();
    try {
      const ops = generateScript(701, 25);

      const result = await runApplierConformance<never>({
        engines: [
          { name: 'sqlite', db: engines.sqliteDb },
          { name: 'postgres', db: engines.pgDb },
        ],
        module: fixtureModule(),
        ops,
        hash: (data: Uint8Array) => noblePort.sha256(data),
        insertOp,
        countRows: countFixtureRows,
      });

      // THE DENOMINATOR (T-14), asserted here as well as inside the suite: a digest comparison over
      // two empty projections passes trivially, so the numbers are pinned, not assumed.
      expect(result.opsApplied).toBe(25);
      expect(result.rowCounts.get('sqlite')).toBe(25);
      expect(result.rowCounts.get('postgres')).toBe(25);

      // The actual property (§2.4).
      expect(result.digests.get('sqlite')).toBe(result.digests.get('postgres'));
      // ...and the digest is a real one, not an empty-string sentinel that would equal itself.
      expect(result.digests.get('sqlite')).toMatch(/^[0-9a-f]{16,}/);
    } finally {
      await engines.close();
    }
  });

  test('the gate DETECTS a divergence between the engines', async () => {
    // The gate interrogated (T-11): a conformance suite that cannot go red is decoration. One extra
    // row on SQLite only models the thing T-8 exists to catch — an applier that behaves differently
    // per engine — and the gate must name it rather than shrug.
    const engines = await openEngines();
    try {
      await sql`
        INSERT INTO fixture_items (id, tenant_id, store_id, label, secret_note, created_by, created_at)
        VALUES ('divergent-row', 't', 's', 'only-on-sqlite', 'x', 'u', 1726000000000)
      `.execute(engines.sqliteDb);

      await expect(
        runApplierConformance<never>({
          engines: [
            { name: 'sqlite', db: engines.sqliteDb },
            { name: 'postgres', db: engines.pgDb },
          ],
          module: fixtureModule(),
          ops: generateScript(703, 3),
          hash: (data: Uint8Array) => noblePort.sha256(data),
          insertOp,
          countRows: countFixtureRows,
        }),
      ).rejects.toThrow(/applier conformance FAILED/);
    } finally {
      await engines.close();
    }
  });

  test('the suite REFUSES an empty op script rather than passing vacuously', async () => {
    // Interrogating the gate itself (T-11/T-14): an empty projection digests identically on every
    // engine, so the one way this gate could be green-for-the-wrong-reason is by folding nothing.
    // It refuses instead — and this test is what proves the refusal exists.
    const engines = await openEngines();
    try {
      await expect(
        runApplierConformance<never>({
          engines: [
            { name: 'sqlite', db: engines.sqliteDb },
            { name: 'postgres', db: engines.pgDb },
          ],
          module: fixtureModule(),
          ops: [],
          hash: (data: Uint8Array) => noblePort.sha256(data),
          insertOp,
          countRows: countFixtureRows,
        }),
      ).rejects.toThrow(/EMPTY op script/);
    } finally {
      await engines.close();
    }
  });

  test('the suite REFUSES to run against a single engine', async () => {
    // "Both engines" is the whole rule; one engine trivially agrees with itself.
    const engines = await openEngines();
    try {
      await expect(
        runApplierConformance<never>({
          engines: [{ name: 'sqlite', db: engines.sqliteDb }],
          module: fixtureModule(),
          ops: generateScript(702, 3),
          hash: (data: Uint8Array) => noblePort.sha256(data),
          insertOp,
          countRows: countFixtureRows,
        }),
      ).rejects.toThrow(/BOTH engines/);
    } finally {
      await engines.close();
    }
  });
});
