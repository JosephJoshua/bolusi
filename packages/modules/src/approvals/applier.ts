// The `approvals` projection appliers and table manifest. Each request is its own entity; its
// answer is a second op on it. Appliers never throw on what concurrency can produce (two owners
// answering one request): the rules refuse those, and the fold accepts what the server accepted.
import type { ProjectionApplier, ProjectionTableManifest } from '@bolusi/core';

import { APPROVAL_ENTITY, APPROVAL_OP, type ApprovalStatus } from './constants.js';
import type { ApprovalsDatabase } from './schema.js';

export const approvalRequestsTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    kind: 'text',
    target_type: 'text',
    target_id: 'text',
    input_json: 'text',
    amount: 'integer',
    reason: 'text',
    basis: 'text',
    requested_by: 'text',
    requested_at: 'integer',
    status: 'text',
    decided_by: 'text',
    decided_at: 'integer',
    note: 'text',
  },
  primaryKey: ['id'],
  entityType: APPROVAL_ENTITY,
  entityIdColumn: 'id',
  projectionVersion: 1,
};

export interface RequestedPayload {
  readonly kind: string;
  readonly target: { readonly entityType: string; readonly entityId: string };
  readonly input: Readonly<Record<string, unknown>>;
  readonly amount: number;
  readonly reason: string;
  readonly basis: string;
}

export const requestedApplier: ProjectionApplier<ApprovalsDatabase> = async (db, op) => {
  const payload = op.payload as unknown as RequestedPayload;
  if (op.storeId === null) throw new Error(`approvals applier: ${op.entityId} has no store`);
  await db
    .insertInto('approvalRequests')
    .values({
      id: op.entityId,
      tenantId: op.tenantId,
      storeId: op.storeId,
      kind: payload.kind,
      targetType: payload.target.entityType,
      targetId: payload.target.entityId,
      inputJson: JSON.stringify(payload.input),
      amount: payload.amount,
      reason: payload.reason,
      basis: payload.basis,
      requestedBy: op.userId,
      requestedAt: op.timestamp,
      status: 'waiting',
      decidedBy: null,
      decidedAt: null,
      note: null,
    })
    .execute();
};

const STATUS_BY_OP: Readonly<Record<string, ApprovalStatus>> = {
  [APPROVAL_OP.approved]: 'approved',
  [APPROVAL_OP.rejected]: 'rejected',
  [APPROVAL_OP.withdrawn]: 'withdrawn',
};

/** An answer (or a withdrawal): the first one to fold settles the request. */
export const answeredApplier: ProjectionApplier<ApprovalsDatabase> = async (db, op) => {
  const note = (op.payload as { readonly note?: string | null }).note ?? null;
  await db
    .updateTable('approvalRequests')
    .set({
      status: STATUS_BY_OP[op.type]!,
      decidedBy: op.userId,
      decidedAt: op.timestamp,
      note: note === '' ? null : note,
    })
    .where('id', '=', op.entityId)
    .where('status', '=', 'waiting')
    .execute();
};
