// The single accepted-op INSERT (10-db §3, §5). Shared by the push pipeline and appendSystemOp
// so there is ONE place that writes the operation log (CLAUDE.md §2.8). This is an INSERT of an
// accepted op — never an UPDATE/DELETE of the append-only log (05 §1); the envelope columns exist
// for querying/projections and are cross-checked against `signed_core_jcs`, the wire truth.
import type { TenantDb } from '@bolusi/db-server';
import type { SignedOperation } from '@bolusi/schemas';

// The PRIMARY KEY constraint name Postgres auto-assigns to `operations.id uuid PRIMARY KEY`
// (migration 0003_operations.ts; the `<table>_pkey` rule for an inline column PK): a cross-tenant
// op-id collision on the global PK (10-db §5/§6). The push insert absorbs a conflict on THIS name
// only (task 114/139), so it lives next to the INSERT: rename the constraint in the migration and
// this is the one place the code that matches it must change too.
export const OPERATIONS_PK_CONSTRAINT = 'operations_pkey';

export interface OperationInsert {
  readonly op: SignedOperation;
  readonly serverSeq: number;
  readonly receivedAt: number;
  /** The verbatim JCS bytes hashed/verified — stored as `signed_core_jcs` (05 §3, 10-db §2.1). */
  readonly jcs: string;
  readonly clockSkewFlagged: boolean;
}

function operationRow(input: OperationInsert) {
  const { op } = input;
  return {
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
  };
}

export async function insertOperationRow(db: TenantDb, input: OperationInsert): Promise<void> {
  await db.insertInto('operations').values(operationRow(input)).execute();
}

/**
 * Insert a pushed op unless its id is already taken, and say whether it went in. An id taken by an
 * RLS-hidden row of ANOTHER tenant passes the RLS-scoped dedupe read, so the INSERT is where that
 * collision surfaces; it must read as a plain `duplicate`, never as an error that confirms the
 * foreign id exists (security-guide §2.2; task 114). Only `operations_pkey` is absorbed: any other
 * unique violation, (device_id, seq) or (tenant_id, server_seq), still throws and fails the batch.
 */
export async function insertOperationRowUnlessIdTaken(
  db: TenantDb,
  input: OperationInsert,
): Promise<boolean> {
  const row = await db
    .insertInto('operations')
    .values(operationRow(input))
    .onConflict((oc) => oc.constraint(OPERATIONS_PK_CONSTRAINT).doNothing())
    .returning('id')
    .executeTakeFirst();
  return row !== undefined;
}
