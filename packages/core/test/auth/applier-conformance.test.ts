// THE BOTH-ENGINE RULE for the `auth` module (testing-guide T-8 / 04 §2).
//
// T-8: "Every module's appliers run through the shared applier conformance suite against BOTH
// engines … A module without this suite passing does not merge." This is that suite for the
// `auth_sessions` / `pin_lockout_events` / `auth_permission_denials` appliers.
//
// WHY IT MATTERS HERE. These appliers run on the SERVER (Postgres, push transaction) and on every
// DEVICE (SQLite) over the same signed auth ops. If they disagreed, a phone and the server would
// hold different audit trails derived from identical hash-chained history — the denial the owner
// sees on one and not the other is exactly the write-only-audit failure this task closes, wearing a
// convergence-bug costume.
//
// The script folds ALL EIGHT auth op types — the five that project AND the three that fold to a
// deliberate no-op (device_enrolled genesis, pin_changed, pin_reset). The no-ops are IN the script
// on purpose: if the two engines disagreed about whether a no-op wrote nothing, the digests would
// differ, and T-14's "an empty projection digests identically" trap would be the only thing keeping
// them equal. The runner throws on an `unregistered` op, so every one of the eight must be claimed.
//
// The DDL below is 10-db §549+'s, transcribed to the dialect-neutral subset both engines accept —
// `bigint` (not `integer`) for every ms-epoch column, the asymmetry T-8 caught on its first run.
import { PGlite } from '@electric-sql/pglite';
import { CamelCasePlugin, Kysely, PGliteDialect, sql } from 'kysely';
import { describe, expect, test } from 'vitest';

import { createClientDialect } from '@bolusi/db-client';
import type { SignedOperation } from '@bolusi/schemas';
import { noblePort, runApplierConformance } from '@bolusi/test-support';

import { authModule } from '../../src/auth/index.js';
import type { AnyModuleDefinition } from '../../src/index.js';
import { openMemoryDriver } from '../projection/better-sqlite3-driver.js';

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

  // auth_sessions (10-db §549+). `bigint` for started_at/ended_at.
  await db.schema
    .createTable('auth_sessions')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull())
    .addColumn('store_id', 'text')
    .addColumn('user_id', 'text', (c) => c.notNull())
    .addColumn('device_id', 'text', (c) => c.notNull())
    .addColumn('started_at', 'bigint', (c) => c.notNull())
    .addColumn('ended_at', 'bigint')
    .addColumn('end_reason', 'text')
    .execute();

  // pin_lockout_events (10-db §549+). `bigint` for at; `integer` for the small failure count.
  await db.schema
    .createTable('pin_lockout_events')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull())
    .addColumn('store_id', 'text')
    .addColumn('user_id', 'text', (c) => c.notNull())
    .addColumn('device_id', 'text', (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('failure_count', 'integer')
    .addColumn('at', 'bigint', (c) => c.notNull())
    .execute();

  // auth_permission_denials (10-db §549+). `bigint` for timestamp_ms; `integer` for suppressed_repeats.
  await db.schema
    .createTable('auth_permission_denials')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull())
    .addColumn('store_id', 'text')
    .addColumn('scope_store_id', 'text')
    .addColumn('user_id', 'text', (c) => c.notNull())
    .addColumn('device_id', 'text', (c) => c.notNull())
    .addColumn('timestamp_ms', 'bigint', (c) => c.notNull())
    .addColumn('permission_id', 'text', (c) => c.notNull())
    .addColumn('surface', 'text', (c) => c.notNull())
    .addColumn('target', 'text')
    .addColumn('reason', 'text', (c) => c.notNull())
    .addColumn('suppressed_repeats', 'integer', (c) => c.notNull())
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
  let total = 0;
  for (const table of ['auth_sessions', 'pin_lockout_events', 'auth_permission_denials']) {
    const r = await sql<{ c: number | string }>`SELECT COUNT(*) AS c FROM ${sql.table(
      table,
    )}`.execute(db);
    total += Number(r.rows[0]?.c ?? 0);
  }
  return total;
}

const TENANT = '00000000-0000-7000-8000-00000000t001';
const STORE = '00000000-0000-7000-8000-00000000s001';
const DEVICE = '00000000-0000-7000-8000-00000000d001';
const USER_A = '00000000-0000-7000-8000-0000000user-a';
const USER_B = '00000000-0000-7000-8000-0000000user-b';
const USER_C = '00000000-0000-7000-8000-0000000user-c';
const USER_D = '00000000-0000-7000-8000-0000000user-d';
const OWNER = '00000000-0000-7000-8000-00000000ownr';
const S1 = '00000000-0000-7000-8000-000000000sn1';
const S2 = '00000000-0000-7000-8000-000000000sn2';
const D1 = '00000000-0000-7000-8000-000000000dn1';
const D2 = '00000000-0000-7000-8000-000000000dn2';

function op(
  partial: Partial<SignedOperation> &
    Pick<SignedOperation, 'type' | 'entityType' | 'entityId' | 'payload' | 'userId'>,
  i: number,
): SignedOperation {
  return {
    id: `op-${String(i).padStart(4, '0')}`,
    tenantId: TENANT,
    storeId: STORE,
    deviceId: DEVICE,
    seq: i,
    schemaVersion: 1,
    // Real ms epoch — canonical order is timestamp,deviceId,seq (05 §4), and a ~1.7e12 value
    // overflows a Postgres 32-bit integer while SQLite swallows it (the T-8 asymmetry).
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

/** A deterministic script exercising EVERY auth applier and every no-op branch. */
function script(): SignedOperation[] {
  return [
    // 1 — genesis: device_enrolled, seq 1, folds NOTHING (no projection). Its presence proves the
    // no-op is dialect-identical, not just absent.
    op(
      {
        type: 'auth.device_enrolled',
        entityType: 'device',
        entityId: DEVICE,
        userId: OWNER,
        payload: { storeId: STORE, deviceName: 'Front counter', devicePublicKeyB64: 'cHVia2V5' },
      },
      1,
    ),
    // 2 — user A switches in: opens session S1.
    op(
      {
        type: 'auth.user_switched',
        entityType: 'auth_session',
        entityId: S1,
        userId: USER_A,
        payload: { previousSessionId: null, previousUserId: null },
      },
      2,
    ),
    // 3 — user B switches in: ENDS S1 (reason switch; envelope userId = the incoming user, §6.3).
    op(
      {
        type: 'auth.session_ended',
        entityType: 'auth_session',
        entityId: S1,
        userId: USER_B,
        payload: { reason: 'switch' },
      },
      3,
    ),
    // 4 — …and opens session S2 (still open at the end — ended_at stays null).
    op(
      {
        type: 'auth.user_switched',
        entityType: 'auth_session',
        entityId: S2,
        userId: USER_B,
        payload: { previousSessionId: S1, previousUserId: USER_A },
      },
      4,
    ),
    // 5 — user C hard-locks: pin_locked_out (failure_count 10).
    op(
      {
        type: 'auth.pin_locked_out',
        entityType: 'user_credential',
        entityId: USER_C,
        userId: USER_C,
        payload: { consecutiveFailures: 10, windowStartedAt: 1_726_000_004_500 },
      },
      5,
    ),
    // 6 — owner clears C's lockout: pin_lockout_cleared (failure_count NULL — the nullable-column
    // digest case).
    op(
      {
        type: 'auth.pin_lockout_cleared',
        entityType: 'user_credential',
        entityId: USER_C,
        userId: OWNER,
        payload: {},
      },
      6,
    ),
    // 7 — pin_changed (no projection): the credential moves in the directory, not here.
    op(
      {
        type: 'auth.pin_changed',
        entityType: 'user_credential',
        entityId: USER_C,
        userId: USER_C,
        payload: { targetUserId: USER_C, verifierRef: 'ref-c-1' },
      },
      7,
    ),
    // 8 — pin_reset (no projection), a different user.
    op(
      {
        type: 'auth.pin_reset',
        entityType: 'user_credential',
        entityId: USER_D,
        userId: OWNER,
        payload: { targetUserId: USER_D, verifierRef: 'ref-d-1' },
      },
      8,
    ),
    // 9 — a denial with a TENANT-scope check (scope_store_id null), no suppressed repeats.
    op(
      {
        type: 'auth.permission_denied',
        entityType: 'permission_denial',
        entityId: D1,
        userId: USER_A,
        payload: {
          permissionId: 'auth.role_manage',
          surface: 'command',
          target: 'auth.manageRole',
          reason: 'not_granted',
          scopeStoreId: null,
          suppressedRepeats: 0,
        },
      },
      9,
    ),
    // 10 — a denial with a STORE-scope check AND suppressed repeats > 0 (the throttle's flush).
    op(
      {
        type: 'auth.permission_denied',
        entityType: 'permission_denial',
        entityId: D2,
        userId: USER_A,
        payload: {
          permissionId: 'notes.create',
          surface: 'command',
          target: 'notes.createNote',
          reason: 'restriction_violated',
          scopeStoreId: STORE,
          suppressedRepeats: 3,
        },
      },
      10,
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

const auth = authModule as unknown as AnyModuleDefinition<never>;

describe('auth applier conformance: SQLite vs Postgres (T-8 / 04 §2)', () => {
  test('the same op script folds to byte-identical oracle digests on both engines', async () => {
    const engines = await openEngines();
    try {
      const result = await runApplierConformance<never>({
        engines: [
          { name: 'sqlite', db: engines.sqliteDb },
          { name: 'postgres', db: engines.pgDb },
        ],
        module: auth,
        ops: script(),
        hash: (data: Uint8Array) => noblePort.sha256(data),
        insertOp,
        countRows,
      });

      // THE DENOMINATOR (T-14), pinned rather than assumed — two empty projections digest
      // identically, so equality alone would prove nothing.
      expect(result.opsApplied).toBe(10);
      // 2 sessions + 2 lockout events + 2 denials = 6 rows. NOT 10: three ops fold to no-ops
      // (genesis + pin_changed + pin_reset) and one session_ended UPDATES rather than inserts. The
      // number encodes the fold's semantics, which is why it is asserted rather than `> 0`.
      expect(result.rowCounts.get('sqlite')).toBe(6);
      expect(result.rowCounts.get('postgres')).toBe(6);

      expect(result.digests.get('sqlite')).toBe(result.digests.get('postgres'));
      expect(result.digests.get('sqlite')).toMatch(/^[0-9a-f]{16,}/);
    } finally {
      await engines.close();
    }
  });

  test('the fold produced the SEMANTICS the digests agree on', async () => {
    // A digest-equality gate proves the engines AGREE; it cannot say they agree on the right answer.
    // Two identically-wrong appliers pass it. So this reads the rows back and asserts the api/02-auth
    // §6.2 facts directly — the oracle's blind spot, covered on one engine.
    const engines = await openEngines();
    try {
      await runApplierConformance<never>({
        engines: [
          { name: 'sqlite', db: engines.sqliteDb },
          { name: 'postgres', db: engines.pgDb },
        ],
        module: auth,
        ops: script(),
        hash: (data: Uint8Array) => noblePort.sha256(data),
        insertOp,
        countRows,
      });

      // auth_sessions: S1 CLOSED by the switch, S2 still OPEN.
      const sessions = await sql<{
        id: string;
        userId: string;
        endedAt: number | string | null;
        endReason: string | null;
      }>`SELECT id, user_id, ended_at, end_reason FROM auth_sessions ORDER BY started_at`.execute(
        engines.pgDb,
      );
      expect(sessions.rows.map((r) => r.id)).toEqual([S1, S2]);
      // S1: opened by USER_A, closed reason 'switch'.
      expect(sessions.rows[0]?.userId).toBe(USER_A);
      expect(sessions.rows[0]?.endReason).toBe('switch');
      expect(sessions.rows[0]?.endedAt).not.toBeNull();
      // S2: opened by USER_B, still open.
      expect(sessions.rows[1]?.userId).toBe(USER_B);
      expect(sessions.rows[1]?.endedAt).toBeNull();
      expect(sessions.rows[1]?.endReason).toBeNull();

      // pin_lockout_events: one lock (failure_count 10), one clear (null), both for USER_C.
      const events = await sql<{
        userId: string;
        kind: string;
        failureCount: number | string | null;
      }>`SELECT user_id, kind, failure_count FROM pin_lockout_events ORDER BY at`.execute(
        engines.pgDb,
      );
      expect(events.rows.map((r) => r.kind)).toEqual(['pin_locked_out', 'pin_lockout_cleared']);
      expect(events.rows.every((r) => r.userId === USER_C)).toBe(true);
      expect(Number(events.rows[0]?.failureCount)).toBe(10);
      expect(events.rows[1]?.failureCount).toBeNull();

      // auth_permission_denials: the load-bearing audit — six-field payload + suppression preserved.
      const denials = await sql<{
        id: string;
        scopeStoreId: string | null;
        reason: string;
        permissionId: string;
        target: string | null;
        suppressedRepeats: number | string;
      }>`SELECT id, scope_store_id, reason, permission_id, target, suppressed_repeats
         FROM auth_permission_denials ORDER BY timestamp_ms`.execute(engines.pgDb);
      expect(denials.rows.map((r) => r.id)).toEqual([D1, D2]);
      // D1: tenant-scope check (scope_store_id NULL), not_granted, no suppressed repeats.
      expect(denials.rows[0]?.scopeStoreId).toBeNull();
      expect(denials.rows[0]?.reason).toBe('not_granted');
      expect(Number(denials.rows[0]?.suppressedRepeats)).toBe(0);
      // D2: store-scoped, restriction_violated, and the throttle's flushed count SURVIVES the fold.
      expect(denials.rows[1]?.scopeStoreId).toBe(STORE);
      expect(denials.rows[1]?.reason).toBe('restriction_violated');
      expect(denials.rows[1]?.permissionId).toBe('notes.create');
      expect(Number(denials.rows[1]?.suppressedRepeats)).toBe(3);
    } finally {
      await engines.close();
    }
  });
});
