// Client-DB glue for the harness: open a VirtualDevice's own SQLite (the ONE dialect from
// @bolusi/db-client + the real client migrations), and the pulled-op insert the DIRECT-FEED path
// needs (CHAOS-01's arrival-order permutations the protocol itself cannot produce, §3.6).
//
// This owns NO protocol logic (T-7): the op is already a signed, chained `SignedOperation`; the
// insert only writes the operation-log columns 10-db §9.2 declares, exactly as the production pull
// path's `insertPulledOp` does (syncStatus 'synced', the assigned serverSeq). The row→wire mapper is
// the inverse of that column list. Folding is the REAL engine (`applyPulledOp`), never re-done here.
import { CamelCasePlugin, Kysely, sql } from 'kysely';

import {
  createClientDialect,
  runClientMigrations,
  type ClientDatabase,
  type DbDriver,
} from '@bolusi/db-client';
import type { SignedOperation } from '@bolusi/schemas';

import { openMemoryDriver } from './driver.js';

export interface ClientDbHandle {
  readonly driver: DbDriver;
  readonly db: Kysely<ClientDatabase>;
  close(): Promise<void>;
}

/** Open a fresh device DB: one better-sqlite3 connection, the real client migrations, the shim. */
export async function openClientDb(): Promise<ClientDbHandle> {
  const driver = openMemoryDriver();
  await runClientMigrations(driver, { now: () => 1 });
  const db = new Kysely<ClientDatabase>({
    dialect: createClientDialect(driver),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });
  return {
    driver,
    db,
    close: async () => {
      await db.destroy();
      await driver.close();
    },
  };
}

/** Every operation-log column, ascending by the SQLite row's own order — the `operations` shape. */
interface OperationRow {
  id: string;
  tenantId: string;
  storeId: string | null;
  userId: string;
  deviceId: string;
  seq: number;
  type: string;
  entityType: string;
  entityId: string;
  schemaVersion: number;
  payload: string;
  timestampMs: number;
  location: string | null;
  source: string;
  agentInitiated: number;
  agentConversationId: string | null;
  previousHash: string;
  hash: string;
  signature: string;
  serverSeq: number | null;
}

/** Reconstruct the wire `SignedOperation` from a stored `operations` row (the insert's inverse). */
function rowToWireOp(row: OperationRow): SignedOperation {
  return {
    id: row.id,
    tenantId: row.tenantId,
    storeId: row.storeId,
    userId: row.userId,
    deviceId: row.deviceId,
    seq: row.seq,
    type: row.type,
    entityType: row.entityType,
    entityId: row.entityId,
    schemaVersion: row.schemaVersion,
    payload: JSON.parse(row.payload) as SignedOperation['payload'],
    timestamp: row.timestampMs,
    location:
      row.location === null ? null : (JSON.parse(row.location) as SignedOperation['location']),
    source: row.source as SignedOperation['source'],
    agentInitiated: row.agentInitiated === 1,
    agentConversationId: row.agentConversationId,
    previousHash: row.previousHash,
    hash: row.hash,
    signature: row.signature,
  };
}

/** Every op this device holds, wire shape, ascending by local `seq` per device then serverSeq. */
export async function readWireOps(db: Kysely<ClientDatabase>): Promise<SignedOperation[]> {
  const rows = (await db
    .selectFrom('operations')
    .selectAll()
    .orderBy('deviceId')
    .orderBy('seq')
    .execute()) as unknown as OperationRow[];
  return rows.map(rowToWireOp);
}

/**
 * Insert a foreign op as `synced` (the production pull path's `insertPulledOp`). Idempotent on `id`
 * (INSERT OR IGNORE) so a duplicate delivery is a no-op — CHAOS-06's replay property, in the seam.
 */
export async function insertPulledOp(
  db: Kysely<ClientDatabase>,
  op: SignedOperation,
  serverSeq: number,
  syncedAt: number,
): Promise<void> {
  await sql`
    INSERT OR IGNORE INTO operations (
      id, tenant_id, store_id, user_id, device_id, seq, type, entity_type, entity_id,
      schema_version, payload, timestamp_ms, location, source, agent_initiated,
      agent_conversation_id, previous_hash, hash, signature, signed_core_jcs,
      sync_status, server_seq, synced_at
    ) VALUES (
      ${op.id}, ${op.tenantId}, ${op.storeId}, ${op.userId}, ${op.deviceId}, ${op.seq}, ${op.type},
      ${op.entityType}, ${op.entityId}, ${op.schemaVersion}, ${JSON.stringify(op.payload)},
      ${op.timestamp}, ${op.location === null ? null : JSON.stringify(op.location)}, ${op.source},
      ${op.agentInitiated ? 1 : 0}, ${op.agentConversationId}, ${op.previousHash}, ${op.hash},
      ${op.signature}, ${''}, 'synced', ${serverSeq}, ${syncedAt}
    )
  `.execute(db);
}
