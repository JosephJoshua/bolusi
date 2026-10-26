// The one writer of a client op-log row (10-db §9.2): the local append (db-client's op store), the
// pull, and the tests and chaos rig that put an op in the log exactly as a device would.
//
// The signed text is the op's one stored copy of its payload and location (client migration 6), so
// it must be the op's real canonical text (`signedCoreJcsOf`): readers rebuild the op from it. It is
// sealed compressed. It is passed in, like the append store's `insertOp`, so a caller that already
// computed it (the append signs it, the pull verifies it) does not canonicalize twice.
import { sql, type Kysely } from 'kysely';

import { encryptColumnValue, SIGNED_CORE_SEAL } from '../crypto/column-cipher.js';
import type { OpSyncStatus } from '../state-machines/op-sync-status.js';
import type { OpRow } from './append.js';

/** The bookkeeping a row is born with (03 §3 birth table). */
export interface OpLogRowBookkeeping {
  readonly syncStatus: OpSyncStatus;
  readonly syncedAt: number | null;
  /** The pull's local arrival counter; `null` for this device's own ops (10-db §9.2). */
  readonly arrivalSeq: number | null;
}

/** Insert one op-log row; the signed text is sealed with `SIGNED_CORE_SEAL`. */
export async function insertOpLogRow<DB>(
  db: Kysely<DB>,
  { op, signedCoreJcs }: OpRow,
  bookkeeping: OpLogRowBookkeeping,
): Promise<void> {
  await sql`
    INSERT INTO operations (
      id, tenant_id, store_id, user_id, device_id, seq, type, entity_type, entity_id,
      schema_version, timestamp_ms, source, agent_initiated,
      agent_conversation_id, previous_hash, hash, signature, signed_core_jcs,
      sync_status, synced_at, arrival_seq
    ) VALUES (
      ${op.id}, ${op.tenantId}, ${op.storeId}, ${op.userId}, ${op.deviceId}, ${op.seq}, ${op.type},
      ${op.entityType}, ${op.entityId}, ${op.schemaVersion}, ${op.timestamp}, ${op.source},
      ${op.agentInitiated ? 1 : 0}, ${op.agentConversationId}, ${op.previousHash}, ${op.hash},
      ${op.signature}, ${encryptColumnValue(db, signedCoreJcs, SIGNED_CORE_SEAL)},
      ${bookkeeping.syncStatus}, ${bookkeeping.syncedAt}, ${bookkeeping.arrivalSeq}
    )
  `.execute(db);
}
