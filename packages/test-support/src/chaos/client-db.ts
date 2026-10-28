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
// assigned arrival_seq). Folding is the REAL engine (`applyPulledOp`), never re-done here.
//
// The pulled-op insert is production's own (`insertOpLogRow`, @bolusi/core), and the readback
// rebuilds each op from its stored signed text, as every production reader does (client migration 6).
import { insertOpLogRow, operationFromSignedCoreJcs, type OpAppendStore } from '@bolusi/core';
import type { ClientDatabase, DbDriver } from '@bolusi/db-client';
import type { SignedOperation } from '@bolusi/schemas';
import { sql, type Kysely } from 'kysely';

import { opRowOf } from '../oplog-fixtures/row.js';

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

/** Every op this device holds, wire shape, ascending by local `seq` per device then arrival order. */
export async function readWireOps(db: Kysely<ClientDatabase>): Promise<SignedOperation[]> {
  const rows = await db
    .selectFrom('operations')
    .select(['signedCoreJcs', 'hash', 'signature'])
    .orderBy('deviceId')
    .orderBy('seq')
    .execute();
  return rows.map((row) => operationFromSignedCoreJcs(row.signedCoreJcs, row));
}

/**
 * Insert a foreign op as `synced` (the production pull path's insert). Idempotent on `id` so a
 * duplicate delivery is a no-op — CHAOS-06's replay property, in the seam (the pull dedups the same
 * way before inserting, 05 §5).
 */
export async function insertPulledOp(
  db: Kysely<ClientDatabase>,
  op: SignedOperation,
  arrivalSeq: number,
  syncedAt: number,
): Promise<void> {
  const held = await sql<{ one: number }>`
    SELECT 1 AS one FROM operations WHERE id = ${op.id} LIMIT 1
  `.execute(db);
  if (held.rows.length > 0) return;
  await insertOpLogRow(db, opRowOf(op), { syncStatus: 'synced', syncedAt, arrivalSeq });
}
