// THE BOTH-ENGINE RULE for the `platform` module (testing-guide T-8 / 04 §2).
//
// T-8: "Every module's appliers run through the shared applier conformance suite against BOTH
// engines … A module without this suite passing does not merge." This is that suite for the
// `conflicts` + `user_prefs` appliers.
//
// WHY IT MATTERS HERE SPECIFICALLY. These two appliers run on the SERVER (Postgres, via the push
// transaction) and on every DEVICE (SQLite) over the same signed ops. If they disagreed, a phone
// and the server would hold different answers derived from identical, hash-chained history — both
// internally consistent, both syncing happily, and the divergence surfacing as "my phone says this
// conflict is acknowledged and the owner's doesn't".
//
// ── WHAT THIS GATE DOES NOT PROVE (T-14f — state it, because a gate implying absent coverage is
//    worse than an absent one) ────────────────────────────────────────────────────────────────
//
// It runs better-sqlite3 and PGlite. NEITHER is the production Postgres client. So it proves SQL
// DIALECT neutrality and nothing about `pg`'s marshalling. That is fine for these two appliers,
// and the reason is worth writing down rather than assuming: neither of them READS a bigint column
// to compute anything. `userLocaleChangedApplier` deletes-then-inserts (see its header for why it
// does NOT compare `updated_at` — that comparison would be exactly the T-14f bug); the conflicts
// appliers write literals and filter on `id`/`status`, both `text`. The int8-bearing predicates in
// this surface are Rule 1's, they live in `@bolusi/db-server`, and they are proven on the
// attributed real-PG16 lane by `packages/db-server/test/conflict-candidates-pg.test.ts`.
//
// The DDL below is 10-db's, transcribed to the dialect-neutral subset both engines accept — the
// same compromise `core/test/module/applier-conformance.test.ts` documents: db-client's migrations
// are SQLite-only, db-server's are Postgres-only, and `@bolusi/core` may import neither (08 §3.3).
import { PGlite } from '@electric-sql/pglite';
import { CamelCasePlugin, Kysely, PGliteDialect, sql } from 'kysely';
import { describe, expect, test } from 'vitest';

import { createClientDialect } from '@bolusi/db-client';
import type { SignedOperation } from '@bolusi/schemas';
import { noblePort, runApplierConformance } from '@bolusi/test-support';

import { platformModule } from '../../src/platform/index.js';
import type { AnyModuleDefinition } from '../../src/index.js';
import { openMemoryDriver } from '../projection/better-sqlite3-driver.js';

/**
 * The op-log + watermark DDL the engine reads, plus the two platform projection tables.
 *
 * `bigint`, not `integer`, for every ms-epoch/seq column: Postgres `integer` is 32-bit and an
 * ms-epoch (~1.7e12) overflows it, while SQLite's INTEGER swallows it silently — the asymmetry
 * T-8 caught on its very first run in this repo.
 */
async function createTables(db: Kysely<never>): Promise<void> {
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
    .addColumn('server_seq', 'bigint')
    .addColumn('synced_at', 'bigint')
    .execute();

  await db.schema
    .createTable('projection_watermarks')
    .addColumn('module_id', 'text', (c) => c.primaryKey())
    .addColumn('applied_server_seq', 'bigint', (c) => c.notNull().defaultTo(0))
    .addColumn('applied_local_seq', 'bigint', (c) => c.notNull().defaultTo(0))
    .execute();

  await db.schema
    .createTable('meta_kv')
    .addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('value', 'text', (c) => c.notNull())
    .execute();

  // `conflicts` (10-db §8 / §9.6). Column names verbatim — `op_a_id`/`op_b_id` are the live
  // CamelCasePlugin trap (10-db §11): default `snakeCase('opAId')` is `'op_aid'`, which
  // typechecks and fails at runtime. Both engines below construct the plugin with
  // `{ underscoreBetweenUppercaseLetters: true }`, exactly as production does.
  await db.schema
    .createTable('conflicts')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull())
    .addColumn('store_id', 'text')
    .addColumn('entity_type', 'text', (c) => c.notNull())
    .addColumn('entity_id', 'text', (c) => c.notNull())
    .addColumn('conflict_key', 'text', (c) => c.notNull())
    .addColumn('severity', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('op_a_id', 'text', (c) => c.notNull())
    .addColumn('op_b_id', 'text', (c) => c.notNull())
    .addColumn('detected_at', 'bigint', (c) => c.notNull())
    .addColumn('acknowledged_by', 'text')
    .addColumn('acknowledged_at', 'bigint')
    .addColumn('acknowledgement_op_id', 'text')
    .execute();

  await db.schema
    .createTable('user_prefs')
    .addColumn('user_id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull())
    .addColumn('locale', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'bigint', (c) => c.notNull())
    .execute();
}

async function insertOp(db: Kysely<never>, op: SignedOperation): Promise<void> {
  await sql`
    INSERT INTO operations (
      id, tenant_id, store_id, user_id, device_id, seq, type, entity_type, entity_id,
      schema_version, payload, timestamp_ms, location, source, agent_initiated,
      agent_conversation_id, previous_hash, hash, signature, signed_core_jcs, sync_status,
      server_seq, synced_at
    ) VALUES (
      ${op.id}, ${op.tenantId}, ${op.storeId}, ${op.userId}, ${op.deviceId}, ${op.seq}, ${op.type},
      ${op.entityType}, ${op.entityId}, ${op.schemaVersion}, ${JSON.stringify(op.payload)},
      ${op.timestamp}, ${null}, ${op.source}, ${op.agentInitiated ? 1 : 0}, ${null},
      ${op.previousHash}, ${op.hash}, ${op.signature}, ${`jcs:${op.id}`}, ${'local'}, ${null}, ${null}
    )
  `.execute(db);
}

async function countRows(db: Kysely<never>): Promise<number> {
  const conflicts = await sql<{ c: number | string }>`SELECT COUNT(*) AS c FROM conflicts`.execute(
    db,
  );
  const prefs = await sql<{ c: number | string }>`SELECT COUNT(*) AS c FROM user_prefs`.execute(db);
  return Number(conflicts.rows[0]?.c ?? 0) + Number(prefs.rows[0]?.c ?? 0);
}

const TENANT = '00000000-0000-7000-8000-00000000t001';
const STORE = '00000000-0000-7000-8000-00000000s001';
const SYSTEM_DEVICE = '00000000-0000-7000-8000-00000000d999';

function op(
  partial: Partial<SignedOperation> &
    Pick<SignedOperation, 'type' | 'entityType' | 'entityId' | 'payload'>,
  i: number,
): SignedOperation {
  return {
    id: `op-${String(i).padStart(4, '0')}`,
    tenantId: TENANT,
    storeId: STORE,
    userId: `user-${i % 2}`,
    deviceId: SYSTEM_DEVICE,
    seq: i,
    schemaVersion: 1,
    timestamp: 1_726_000_000_000 + i * 1_000,
    location: null,
    source: 'system',
    agentInitiated: false,
    agentConversationId: null,
    previousHash: '0'.repeat(64),
    hash: String(i).padStart(64, '0'),
    signature: `sig-${i}`,
    ...partial,
  } as SignedOperation;
}

/**
 * A deterministic script exercising EVERY platform applier and every branch that writes.
 *
 * Deliberately includes the acknowledgment of a `surfaced` conflict AND an ack against an
 * `auto_resolved` one: the second is the applier's no-op branch (03 §7's total rule), and if the
 * two engines disagreed about whether a no-op wrote nothing, the digests would differ.
 */
function script(): SignedOperation[] {
  const c1 = '00000000-0000-7000-8000-0000000000c1'; // significant → surfaced → acknowledged
  const c2 = '00000000-0000-7000-8000-0000000000c2'; // minor → auto_resolved (terminal)
  return [
    op(
      {
        type: 'platform.conflict_detected',
        entityType: 'conflict',
        entityId: c1,
        payload: {
          entityType: 'note',
          entityId: 'note-1',
          conflictKey: 'note.archived',
          severity: 'significant',
          opAId: 'op-a1',
          opBId: 'op-b1',
        },
      },
      1,
    ),
    op(
      {
        type: 'platform.conflict_detected',
        entityType: 'conflict',
        entityId: c2,
        // Tenant-scoped conflict: `store_id` NULL. Nullable-column handling is a classic place for
        // two engines to disagree about what a digest of NULL looks like.
        storeId: null,
        payload: {
          entityType: 'note',
          entityId: 'note-2',
          conflictKey: 'note.body',
          severity: 'minor',
          opAId: 'op-a2',
          opBId: 'op-b2',
        },
      },
      2,
    ),
    // surfaced → acknowledged (03 §7).
    op(
      {
        type: 'platform.conflict_acknowledged',
        entityType: 'conflict',
        entityId: c1,
        payload: { note: 'seen — awkward text: quotes \'"\n and ünïcode ✓' },
      },
      3,
    ),
    // A SECOND ack of the same conflict — folds as a no-op, first-in-canonical-order wins.
    op(
      {
        type: 'platform.conflict_acknowledged',
        entityType: 'conflict',
        entityId: c1,
        payload: { note: 'later ack — must not overwrite' },
      },
      4,
    ),
    // An ack against an `auto_resolved` conflict — also a no-op (terminal, 01 §8.3).
    op(
      {
        type: 'platform.conflict_acknowledged',
        entityType: 'conflict',
        entityId: c2,
        payload: { note: null },
      },
      5,
    ),
    op(
      {
        type: 'platform.user_locale_changed',
        entityType: 'user_pref',
        entityId: 'user-7',
        storeId: null,
        payload: { locale: 'en' },
      },
      6,
    ),
    // LWW: the same user again — the delete-then-insert branch, on both engines.
    op(
      {
        type: 'platform.user_locale_changed',
        entityType: 'user_pref',
        entityId: 'user-7',
        storeId: null,
        payload: { locale: 'id' },
      },
      7,
    ),
  ];
}

async function openEngines() {
  const driver = openMemoryDriver();
  const sqliteDb = new Kysely<never>({
    dialect: createClientDialect(driver),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });
  const pglite = new PGlite();
  const pgDb = new Kysely<never>({
    dialect: new PGliteDialect({ pglite }),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });
  for (const db of [sqliteDb, pgDb]) await createTables(db);
  return {
    sqliteDb,
    pgDb,
    close: async () => {
      await sqliteDb.destroy();
      await driver.close();
      await pgDb.destroy();
    },
  };
}

const platform = platformModule as unknown as AnyModuleDefinition<never>;

describe('platform applier conformance: SQLite vs Postgres (T-8 / 04 §2)', () => {
  test('the same op script folds to byte-identical oracle digests on both engines', async () => {
    const engines = await openEngines();
    try {
      const ops = script();
      const result = await runApplierConformance<never>({
        engines: [
          { name: 'sqlite', db: engines.sqliteDb },
          { name: 'postgres', db: engines.pgDb },
        ],
        module: platform,
        ops,
        hash: (data: Uint8Array) => noblePort.sha256(data),
        insertOp,
        countRows,
      });

      // THE DENOMINATOR (T-14), pinned rather than assumed — two empty projections digest
      // identically, so equality alone would prove nothing.
      expect(result.opsApplied).toBe(7);
      // 2 conflicts + 1 user_pref = 3 rows on each engine. NOT 7: three acks fold into existing
      // rows (one updates, two are no-ops) and the second locale change replaces the first. The
      // number encodes the fold's semantics, which is why it is asserted rather than `> 0`.
      expect(result.rowCounts.get('sqlite')).toBe(3);
      expect(result.rowCounts.get('postgres')).toBe(3);

      expect(result.digests.get('sqlite')).toBe(result.digests.get('postgres'));
      expect(result.digests.get('sqlite')).toMatch(/^[0-9a-f]{16,}/);
    } finally {
      await engines.close();
    }
  });

  test('the fold produced the SEMANTICS the digests agree on', async () => {
    // A digest-equality gate proves the engines AGREE; it cannot say they agree on the right
    // answer. Two identically-wrong appliers pass it. So this reads the rows back and asserts the
    // 03 §7 lifecycle facts directly — the oracle's blind spot, covered on one engine.
    const engines = await openEngines();
    try {
      await runApplierConformance<never>({
        engines: [
          { name: 'sqlite', db: engines.sqliteDb },
          { name: 'postgres', db: engines.pgDb },
        ],
        module: platform,
        ops: script(),
        hash: (data: Uint8Array) => noblePort.sha256(data),
        insertOp,
        countRows,
      });

      // Result keys are camelCase: the CamelCasePlugin maps them on the way OUT as well as in,
      // which is the same mapping production reads through.
      const rows = await sql<{
        id: string;
        severity: string;
        status: string;
        acknowledgedBy: string | null;
        acknowledgementOpId: string | null;
      }>`SELECT id, severity, status, acknowledged_by, acknowledgement_op_id FROM conflicts ORDER BY id`.execute(
        engines.pgDb,
      );

      // significant → surfaced → acknowledged, by the FIRST ack (op-0003), not the later one.
      const c1 = rows.rows[0];
      expect(c1?.severity).toBe('significant');
      expect(c1?.status).toBe('acknowledged');
      expect(c1?.acknowledgementOpId).toBe('op-0003');

      // minor → auto_resolved, and the ack against it changed NOTHING (terminal, 01 §8.3).
      const c2 = rows.rows[1];
      expect(c2?.severity).toBe('minor');
      expect(c2?.status).toBe('auto_resolved');
      expect(c2?.acknowledgedBy).toBeNull();

      // LWW on user_prefs: the canonically-later locale won.
      const prefs = await sql<{ locale: string }>`SELECT locale FROM user_prefs`.execute(
        engines.pgDb,
      );
      expect(prefs.rows[0]?.locale).toBe('id');
    } finally {
      await engines.close();
    }
  });
});
