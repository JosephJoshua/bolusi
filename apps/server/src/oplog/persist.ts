// The single accepted-op INSERT (10-db §3, §5). Shared by the push pipeline and appendSystemOp
// so there is ONE place that writes the operation log (CLAUDE.md §2.8). This is an INSERT of an
// accepted op — never an UPDATE/DELETE of the append-only log (05 §1); the envelope columns exist
// for querying/projections and are cross-checked against `signed_core_jcs`, the wire truth.
import type { TenantDb } from '@bolusi/db-server';
import type { SignedOperation } from '@bolusi/schemas';

export interface OperationInsert {
  readonly op: SignedOperation;
  readonly serverSeq: number;
  readonly receivedAt: number;
  /** The verbatim JCS bytes hashed/verified — stored as `signed_core_jcs` (05 §3, 10-db §2.1). */
  readonly jcs: string;
  readonly clockSkewFlagged: boolean;
}

export async function insertOperationRow(db: TenantDb, input: OperationInsert): Promise<void> {
  const { op } = input;
  await db
    .insertInto('operations')
    .values({
      id: op.id,
      tenantId: op.tenantId,
      storeId: op.storeId,
      userId: op.userId,
      deviceId: op.deviceId,
      seq: op.seq,
      type: op.type,
      entityType: op.entityType,
      entityId: op.entityId,
      schemaVersion: op.schemaVersion,
      payload: JSON.stringify(op.payload),
      timestampMs: op.timestamp,
      location: op.location === null ? null : JSON.stringify(op.location),
      source: op.source,
      agentInitiated: op.agentInitiated,
      agentConversationId: op.agentConversationId,
      previousHash: op.previousHash,
      hash: op.hash,
      signature: op.signature,
      signedCoreJcs: input.jcs,
      serverSeq: input.serverSeq,
      receivedAt: input.receivedAt,
      clockSkewFlagged: input.clockSkewFlagged,
    })
    .execute();
}
