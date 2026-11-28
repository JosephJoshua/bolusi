// The supplier payment appliers and table manifest. A payment is its own entity: recorded once,
// and cancelled by a second op on the same entity that marks it, so the history keeps both.
import type { ProjectionApplier, ProjectionOperation, ProjectionTableManifest } from '@bolusi/core';

import { PURCHASING_PAYMENT_ENTITY } from '../constants.js';
import type { PurchasingDatabase } from '../schema.js';

type Applier = ProjectionApplier<PurchasingDatabase>;

export const purchasingPaymentsTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    supplier_id: 'text',
    bill_id: 'text',
    amount: 'integer',
    source: 'text',
    reference: 'text',
    note: 'text',
    created_by: 'text',
    created_at: 'integer',
    voided_by: 'text',
    voided_at: 'integer',
    void_reason: 'text',
  },
  primaryKey: ['id'],
  entityType: PURCHASING_PAYMENT_ENTITY,
  entityIdColumn: 'id',
  projectionVersion: 1,
};

/** What a payment says, as its recorded payload carries it. */
export interface PaymentDetails {
  readonly supplierId: string;
  readonly billId: string | null;
  readonly amount: number;
  readonly source: string;
  readonly reference: string | null;
  readonly note: string | null;
}

function payloadOf<T>(op: ProjectionOperation): T {
  return op.payload as unknown as T;
}

export const supplierPaidApplier: Applier = async (db, op) => {
  const payload = payloadOf<PaymentDetails>(op);
  await db
    .insertInto('purchasingPayments')
    .values({
      id: op.entityId,
      tenantId: op.tenantId,
      // Payment ops are store-scoped, so the store is always stamped.
      storeId: op.storeId ?? '',
      supplierId: payload.supplierId,
      billId: payload.billId,
      amount: payload.amount,
      source: payload.source,
      reference: payload.reference,
      note: payload.note,
      createdBy: op.userId,
      createdAt: op.timestamp,
      voidedBy: null,
      voidedAt: null,
      voidReason: null,
    })
    .execute();
};

/** A second cancel of the same payment (two owners, offline) changes nothing: the first stands. */
export const supplierPaymentVoidedApplier: Applier = async (db, op) => {
  const payload = payloadOf<{ readonly reason: string }>(op);
  await db
    .updateTable('purchasingPayments')
    .set({ voidedBy: op.userId, voidedAt: op.timestamp, voidReason: payload.reason })
    .where('id', '=', op.entityId)
    .where('tenantId', '=', op.tenantId)
    .where('voidedAt', 'is', null)
    .execute();
};
