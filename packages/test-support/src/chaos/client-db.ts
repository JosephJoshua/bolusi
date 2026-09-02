// Device-safe client-DB glue for the chaos rig (task 181): the pulled-op insert + wire readback the
// DIRECT-FEED path needs (CHAOS-01's arrival-order permutations the protocol itself cannot produce,
// §3.6), plus the `ClientDbHandle` shape a device runs on. This file is PLATFORM-FREE — it never
// opens a connection. Opening (the Node better-sqlite3 driver, or the device op-sqlite driver) is the
// injected `ConvergenceSeams.openDb` (seams.ts); this file only reads/writes the operation-log columns
// through a handle it is handed, so it bundles on Hermes with no `node:` edge (db-client is a
// TYPE-ONLY import here — 08 §3.3: no DB *values* in @bolusi/test-support).
//
// This owns NO protocol logic (T-7): the op is already a signed, chained `SignedOperation`; the
// insert only writes the operation-log columns 10-db §9.2 declares (syncStatus 'synced', the
// assigned arrival_seq), and the row→wire mapper is the inverse of that column list. Folding is the
// REAL engine (`applyPulledOp`), never re-done here.
//
// ONE DELIBERATE DIVERGENCE FROM PRODUCTION `insertPulledOp` (packages/core/src/sync/pull.ts): it
// stores `signed_core_jcs = signedCoreJcsOf(op, crypto)`; this stores `''`. The harness readback
// (`readWireOps`) reconstructs the wire op from the plaintext columns and NEVER consumes
// `signed_core_jcs`, so `''` is inert on every current path — but it is NOT production-parity. A
// future CHAOS-06 / raw-wire consumer that needs the canonical JCS bytes must compute them (or set
// this column via the real primitive), NOT trust a stored value here.
import type { OpAppendStore } from '@bolusi/core';
import type { ClientDatabase, DbDriver } from '@bolusi/db-client';
import type { SignedOperation } from '@bolusi/schemas';
import { sql, type Kysely } from 'kysely';

/**
 * A device's open client DB: the one driver connection, the Kysely instance over it, and the
 * production `OpAppendStore` bound to that connection (05 §9 append path). Built by the injected
 * `ConvergenceSeams.openDb` — the Node harness binds better-sqlite3 + `createClientOpStore`; the
 * on-device rig binds op-sqlite. The rig consumes only this shape, never a DB *value*.
 */
export interface ClientDbHandle {
  readonly driver: DbDriver;
  readonly db: Kysely<ClientDatabase>;
  readonly store: OpAppendStore;
  close(): Promise<void>;
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
  arrivalSeq: number | null;
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

/** Every op this device holds, wire shape, ascending by local `seq` per device then arrival order. */
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
  arrivalSeq: number,
  syncedAt: number,
): Promise<void> {
  await sql`
    INSERT OR IGNORE INTO operations (
      id, tenant_id, store_id, user_id, device_id, seq, type, entity_type, entity_id,
      schema_version, payload, timestamp_ms, location, source, agent_initiated,
      agent_conversation_id, previous_hash, hash, signature, signed_core_jcs,
      sync_status, arrival_seq, synced_at
    ) VALUES (
      ${op.id}, ${op.tenantId}, ${op.storeId}, ${op.userId}, ${op.deviceId}, ${op.seq}, ${op.type},
      ${op.entityType}, ${op.entityId}, ${op.schemaVersion}, ${JSON.stringify(op.payload)},
      ${op.timestamp}, ${op.location === null ? null : JSON.stringify(op.location)}, ${op.source},
      ${op.agentInitiated ? 1 : 0}, ${op.agentConversationId}, ${op.previousHash}, ${op.hash},
      ${op.signature}, ${/* signed_core_jcs — the deliberate non-parity '' from the file header */ ''},
      'synced', ${arrivalSeq}, ${syncedAt}
    )
  `.execute(db);
}
