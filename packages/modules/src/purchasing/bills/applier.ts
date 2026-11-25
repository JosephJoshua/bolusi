// The bill appliers and table manifests. A bill's row and its lines are keyed to the bill, so a bill
// edited on two phones offline folds like an order's details: the later edit's lines stand.
import type { ProjectionApplier, ProjectionOperation, ProjectionTableManifest } from '@bolusi/core';

import { PURCHASING_BILL_ENTITY } from '../constants.js';
import type { PurchasingDatabase } from '../schema.js';

type Applier = ProjectionApplier<PurchasingDatabase>;
type Db = Parameters<Applier>[0];

export const purchasingBillsTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    bill_number: 'text',
    supplier_id: 'text',
    order_id: 'text',
    supplier_ref: 'text',
    billed_on: 'integer',
    due_on: 'integer',
    charges: 'integer',
    note: 'text',
    status: 'text',
    created_by: 'text',
    created_at: 'integer',
    updated_by: 'text',
    updated_at: 'integer',
    voided_by: 'text',
    voided_at: 'integer',
    void_reason: 'text',
  },
  primaryKey: ['id'],
  entityType: PURCHASING_BILL_ENTITY,
  entityIdColumn: 'id',
  projectionVersion: 1,
};

export const purchasingBillLinesTable: ProjectionTableManifest = {
  columns: {
    bill_id: 'text',
    position: 'integer',
    tenant_id: 'text',
    item_id: 'text',
    item_name: 'text',
    qty: 'integer',
    unit_price: 'integer',
  },
  primaryKey: ['bill_id', 'position'],
  entityType: PURCHASING_BILL_ENTITY,
  entityIdColumn: 'bill_id',
  projectionVersion: 1,
};

/** What a bill says, as its recorded and edited payloads carry it. */
export interface BillDetails {
  readonly supplierId: string;
  readonly orderId: string | null;
  readonly supplierRef: string | null;
  readonly billedOn: number;
  readonly dueOn: number | null;
  readonly charges: number;
  readonly note: string | null;
  readonly lines: readonly {
    readonly itemId: string;
    readonly name: string;
    readonly qty: number;
    readonly unitPrice: number;
  }[];
}

function payloadOf<T>(op: ProjectionOperation): T {
  return op.payload as unknown as T;
}

async function writeBillLines(db: Db, op: ProjectionOperation, lines: BillDetails['lines']) {
  await db
    .deleteFrom('purchasingBillLines')
    .where('tenantId', '=', op.tenantId)
    .where('billId', '=', op.entityId)
    .execute();
  if (lines.length === 0) return;
  await db
    .insertInto('purchasingBillLines')
    .values(
      lines.map((line, position) => ({
        billId: op.entityId,
        position,
        tenantId: op.tenantId,
        itemId: line.itemId,
        itemName: line.name,
        qty: line.qty,
        unitPrice: line.unitPrice,
      })),
    )
    .execute();
}

function detailColumns(payload: BillDetails) {
  return {
    supplierId: payload.supplierId,
    orderId: payload.orderId,
    supplierRef: payload.supplierRef,
    billedOn: payload.billedOn,
    dueOn: payload.dueOn,
    charges: payload.charges,
    note: payload.note,
  };
}

export const billRecordedApplier: Applier = async (db, op) => {
  const payload = payloadOf<BillDetails & { readonly billNumber: string }>(op);
  await db
    .insertInto('purchasingBills')
    .values({
      id: op.entityId,
      tenantId: op.tenantId,
      // Bill ops are store-scoped, so the store is always stamped.
      storeId: op.storeId ?? '',
      billNumber: payload.billNumber,
      ...detailColumns(payload),
      status: 'open',
      createdBy: op.userId,
      createdAt: op.timestamp,
      updatedBy: op.userId,
      updatedAt: op.timestamp,
      voidedBy: null,
      voidedAt: null,
      voidReason: null,
    })
    .execute();
  await writeBillLines(db, op, payload.lines);
};

export const billEditedApplier: Applier = async (db, op) => {
  const payload = payloadOf<BillDetails>(op);
  await db
    .updateTable('purchasingBills')
    .set({ ...detailColumns(payload), updatedBy: op.userId, updatedAt: op.timestamp })
    .where('id', '=', op.entityId)
    .where('tenantId', '=', op.tenantId)
    .execute();
  await writeBillLines(db, op, payload.lines);
};

export const billVoidedApplier: Applier = async (db, op) => {
  const payload = payloadOf<{ readonly reason: string }>(op);
  await db
    .updateTable('purchasingBills')
    .set({
      status: 'void',
      voidedBy: op.userId,
      voidedAt: op.timestamp,
      voidReason: payload.reason,
      updatedAt: op.timestamp,
    })
    .where('id', '=', op.entityId)
    .where('tenantId', '=', op.tenantId)
    .execute();
};
