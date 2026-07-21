// Dual-engine test rig for the `notes` appliers (testing-guide §2.4 / T-8): the op-log + watermark
// DDL the projection engine reads, plus the `notes` projection table, transcribed to the
// dialect-neutral subset both better-sqlite3 and PGlite accept — the same compromise the platform
// suite documents (db-client migrations are SQLite-only, db-server's Postgres-only, and neither
// this package nor `@bolusi/core` may import the other engine's).
//
// `bigint`, not `integer`, for every ms-epoch / seq column: Postgres `integer` is 32-bit and an
// ms-epoch (~1.7e12) overflows it while SQLite swallows it silently (the asymmetry T-8 caught on its
// first run). `archived` is `boolean`: Kysely maps it to a real Postgres boolean and to SQLite's
// NUMERIC-affinity `boolean` (which stores the 0/1 the applier writes) — so the two physical types
// match production (10-db: `boolean` on PG, `INTEGER` on SQLite) and the oracle's `'boolean'`
// normalization collapses `true/false` and `0/1` to one digest byte.
import { PGlite } from '@electric-sql/pglite';
import { CamelCasePlugin, Kysely, PGliteDialect, sql } from 'kysely';

import type { SignedOperation } from '@bolusi/schemas';

import { createClientDialect, runClientMigrations, type DbDriver } from '@bolusi/db-client';
import {
  createProjectionEngine,
  ProjectionRegistry,
  type AnyModuleDefinition,
  type InvalidationBus,
  type ProjectionEngine,
} from '@bolusi/core';

import { notesModule } from '../../src/notes/index.js';
import { openMemoryDriver } from './better-sqlite3-driver.js';

// All ids are valid UUIDv7 hex (10-db §2 makes v7 the id format system-wide). This matters beyond
// tidiness: the real server DDL types `id`/`tenant_id`/`store_id`/`media_id`/`created_by`/
// `last_edited_by` as `uuid`, which the production `pg` driver VALIDATES — a non-hex placeholder is
// accepted by SQLite/PGlite-over-text but rejected by real PG16 (the notes-registration lane caught
// exactly this, T-14f). So every id these appliers write is a real uuid.
export const TENANT = '01920000-0000-7000-8000-0000000a0001';
export const STORE = '01920000-0000-7000-8000-0000000a0002';
export const DEVICE_A = '01920000-0000-7000-8000-0000000d000a';
export const DEVICE_B = '01920000-0000-7000-8000-0000000d000b';
export const USER_A = '01920000-0000-7000-8000-0000000e000a';
export const USER_B = '01920000-0000-7000-8000-0000000e000b';
/** A valid media attachment id (UUIDv7 — 01 §5.3; `notes.media_id` is `uuid` on the server). */
export const MEDIA_A = '01920000-0000-7000-8000-0000000f000a';

/** A stable, distinct note entity id (valid UUIDv7 hex) for index `n`. */
export function noteId(n: number): string {
  return `01920000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** A stable op id for index `i`. */
export function opId(i: number): string {
  return `op-${String(i).padStart(6, '0')}`;
}

/** Build a `SignedOperation` for the engine tests (no real signature — the engine never verifies;
 *  it reads the log for canonical order and folds). Overridable so a test pins (timestamp, deviceId,
 *  seq) — the canonical-order key — and the schemaVersion, exactly. */
export function op(
  partial: Partial<SignedOperation> &
    Pick<SignedOperation, 'type' | 'entityType' | 'entityId' | 'payload'>,
  i: number,
): SignedOperation {
  return {
    id: opId(i),
    tenantId: TENANT,
    storeId: STORE,
    userId: USER_A,
    deviceId: DEVICE_A,
    seq: i,
    schemaVersion: 1,
    timestamp: 1_726_000_000_000 + i * 1_000,
    location: null,
    source: 'ui',
    agentInitiated: false,
    agentConversationId: null,
    previousHash: '0'.repeat(64),
    hash: String(i).padStart(64, '0'),
    signature: `sig-${i}`,
    ...partial,
  } as SignedOperation;
}

async function createNotesTables(db: Kysely<never>): Promise<void> {
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

  // `notes` (10-db §8 Postgres / §9.6 SQLite), column names verbatim, DDL order preserved.
  await db.schema
    .createTable('notes')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull())
    .addColumn('store_id', 'text', (c) => c.notNull())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('body', 'text', (c) => c.notNull())
    .addColumn('media_id', 'text')
    .addColumn('archived', 'boolean', (c) => c.notNull())
    .addColumn('edit_count', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('created_by', 'text', (c) => c.notNull())
    .addColumn('created_at', 'bigint', (c) => c.notNull())
    .addColumn('last_edited_by', 'text', (c) => c.notNull())
    .addColumn('last_edited_at', 'bigint', (c) => c.notNull())
    .execute();
}

/** Insert an op into the engine's op-log (the engine reads it to decide head vs re-fold, 04 §4.2). */
export async function insertOp(db: Kysely<never>, op: SignedOperation): Promise<void> {
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

/**
 * Deliver an op through the ENGINE's delivery contract (05 §5 / engine.ts header): dedupe by op id,
 * then insert-before-apply. Models the real pipeline — a duplicate op id is NOT re-inserted, so its
 * apply is never called (idempotent replay). Returns whether it was applied or was a duplicate.
 */
export async function deliver(
  db: Kysely<never>,
  engine: ProjectionEngine<never>,
  operation: SignedOperation,
): Promise<'applied' | 'duplicate'> {
  const existing = await sql<{ one: number }>`
    SELECT 1 AS one FROM operations WHERE id = ${operation.id} LIMIT 1
  `.execute(db);
  if (existing.rows.length > 0) return 'duplicate';
  await insertOp(db, operation);
  await engine.applyAppendedOp(operation);
  return 'applied';
}

/** Row count of the `notes` projection — the T-14 denominator for the conformance runner. */
export async function countNotes(db: Kysely<never>): Promise<number> {
  const result = await sql<{ c: number | string }>`SELECT COUNT(*) AS c FROM notes`.execute(db);
  return Number(result.rows[0]?.c ?? 0);
}

export interface Engines {
  readonly sqliteDb: Kysely<never>;
  readonly pgDb: Kysely<never>;
  close(): Promise<void>;
}

/** A single better-sqlite3 engine over the REAL client migrations (10-db §9), with a notes
 *  projection engine wired to it — for the migration + convergence semantic suites. */
export interface ClientEngine {
  readonly db: Kysely<never>;
  readonly engine: ProjectionEngine<never>;
  close(): Promise<void>;
}

/** Build a notes projection engine over `db` (the same registry `registerModules` produces). */
export function notesProjectionEngine(
  db: Kysely<never>,
  invalidation?: InvalidationBus,
): ProjectionEngine<never> {
  const registry = new ProjectionRegistry<never>();
  const manifest = notesModule as unknown as AnyModuleDefinition<never>;
  registry.register({
    id: manifest.id,
    tables: manifest.projections.tables,
    appliers: Object.fromEntries(
      Object.entries(manifest.operations).map(([type, decl]) => [type, decl.apply]),
    ),
  });
  return createProjectionEngine<never>(
    db,
    registry,
    invalidation !== undefined ? { invalidation } : undefined,
  );
}

/** Open one better-sqlite3 client engine (real 10-db §9 DDL) + a notes projection engine. */
export async function openClientEngine(invalidation?: InvalidationBus): Promise<ClientEngine> {
  const driver: DbDriver = openMemoryDriver();
  await runClientMigrations(driver, { now: () => 1 });
  const db = new Kysely<never>({
    dialect: createClientDialect(driver),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });
  return {
    db,
    engine: notesProjectionEngine(db, invalidation),
    close: async () => {
      await db.destroy();
      await driver.close();
    },
  };
}

/** Open a better-sqlite3 and a PGlite engine, both with the notes op-log + projection DDL. */
export async function openEngines(): Promise<Engines> {
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
  for (const db of [sqliteDb, pgDb]) await createNotesTables(db);
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
