// The `purchasing` projection appliers and table manifests.
//
// A supplier's row is keyed to the supplier, an order's (and its lines) to the order, a receipt's
// (and its lines) to the receipt. Receipts are their own entities, so a late receipt re-folds alone
// and never rewrites an order. Appliers stay total: the rules refuse what must not be recorded, and
// whatever the server accepted still folds.
import type { ProjectionApplier, ProjectionOperation, ProjectionTableManifest } from '@bolusi/core';

import {
  PURCHASING_ORDER_ENTITY,
  PURCHASING_RECEIPT_ENTITY,
  PURCHASING_SUPPLIER_ENTITY,
} from './constants.js';
import type { PurchasingDatabase } from './schema.js';

type Applier = ProjectionApplier<PurchasingDatabase>;
type Db = Parameters<Applier>[0];

export const purchasingSuppliersTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    name: 'text',
    phone: 'text',
    note: 'text',
    archived: 'integer',
    created_by: 'text',
    created_at: 'integer',
    updated_by: 'text',
    updated_at: 'integer',
  },
  primaryKey: ['id'],
  entityType: PURCHASING_SUPPLIER_ENTITY,
  entityIdColumn: 'id',
  projectionVersion: 1,
};

export const purchasingOrdersTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    order_number: 'text',
    supplier_id: 'text',
    status: 'text',
    note: 'text',
    created_by: 'text',
    created_at: 'integer',
    ordered_by: 'text',
    ordered_at: 'integer',
    cancelled_by: 'text',
    cancelled_at: 'integer',
    cancel_reason: 'text',
    updated_at: 'integer',
  },
  primaryKey: ['id'],
  entityType: PURCHASING_ORDER_ENTITY,
  entityIdColumn: 'id',
  projectionVersion: 1,
};

export const purchasingOrderLinesTable: ProjectionTableManifest = {
  columns: {
    order_id: 'text',
    position: 'integer',
    tenant_id: 'text',
    item_id: 'text',
    item_name: 'text',
    qty: 'integer',
  },
  primaryKey: ['order_id', 'position'],
  entityType: PURCHASING_ORDER_ENTITY,
  entityIdColumn: 'order_id',
  projectionVersion: 1,
};

export const purchasingReceiptsTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    order_id: 'text',
    note: 'text',
    user_id: 'text',
    at: 'integer',
  },
  primaryKey: ['id'],
  entityType: PURCHASING_RECEIPT_ENTITY,
  entityIdColumn: 'id',
  projectionVersion: 1,
};

export const purchasingReceiptLinesTable: ProjectionTableManifest = {
  columns: {
    receipt_id: 'text',
    position: 'integer',
    tenant_id: 'text',
    order_id: 'text',
    item_id: 'text',
    qty: 'integer',
  },
  primaryKey: ['receipt_id', 'position'],
  entityType: PURCHASING_RECEIPT_ENTITY,
  entityIdColumn: 'receipt_id',
  projectionVersion: 1,
};

function payloadOf<T>(op: ProjectionOperation): T {
  return op.payload as unknown as T;
}

interface SupplierDetails {
  readonly name: string;
  readonly phone: string | null;
  readonly note: string | null;
}

export const supplierAddedApplier: Applier = async (db, op) => {
  const payload = payloadOf<SupplierDetails>(op);
  await db
    .insertInto('purchasingSuppliers')
    .values({
      id: op.entityId,
      tenantId: op.tenantId,
      name: payload.name,
      phone: payload.phone,
      note: payload.note,
      archived: 0,
      createdBy: op.userId,
      createdAt: op.timestamp,
      updatedBy: op.userId,
      updatedAt: op.timestamp,
    })
    .execute();
};

export const supplierEditedApplier: Applier = async (db, op) => {
  const payload = payloadOf<SupplierDetails & { readonly archived: boolean }>(op);
  await db
    .updateTable('purchasingSuppliers')
    .set({
      name: payload.name,
      phone: payload.phone,
      note: payload.note,
      archived: payload.archived ? 1 : 0,
      updatedBy: op.userId,
      updatedAt: op.timestamp,
    })
    .where('id', '=', op.entityId)
    .where('tenantId', '=', op.tenantId)
    .execute();
};

interface OrderDetails {
  readonly supplierId: string;
  readonly note: string | null;
  readonly lines: readonly {
    readonly itemId: string;
    readonly name: string;
    readonly qty: number;
  }[];
}

async function writeOrderLines(db: Db, op: ProjectionOperation, lines: OrderDetails['lines']) {
  await db
    .deleteFrom('purchasingOrderLines')
    .where('tenantId', '=', op.tenantId)
    .where('orderId', '=', op.entityId)
    .execute();
  if (lines.length === 0) return;
  await db
    .insertInto('purchasingOrderLines')
    .values(
      lines.map((line, position) => ({
        orderId: op.entityId,
        position,
        tenantId: op.tenantId,
        itemId: line.itemId,
        itemName: line.name,
        qty: line.qty,
      })),
    )
    .execute();
}

export const orderDraftedApplier: Applier = async (db, op) => {
  const payload = payloadOf<OrderDetails & { readonly orderNumber: string }>(op);
  await db
    .insertInto('purchasingOrders')
    .values({
      id: op.entityId,
      tenantId: op.tenantId,
      // Order ops are store-scoped, so the store is always stamped.
      storeId: op.storeId ?? '',
      orderNumber: payload.orderNumber,
      supplierId: payload.supplierId,
      status: 'draft',
      note: payload.note,
      createdBy: op.userId,
      createdAt: op.timestamp,
      orderedBy: null,
      orderedAt: null,
      cancelledBy: null,
      cancelledAt: null,
      cancelReason: null,
      updatedAt: op.timestamp,
    })
    .execute();
  await writeOrderLines(db, op, payload.lines);
};

export const orderEditedApplier: Applier = async (db, op) => {
  const payload = payloadOf<OrderDetails>(op);
  await db
    .updateTable('purchasingOrders')
    .set({ supplierId: payload.supplierId, note: payload.note, updatedAt: op.timestamp })
    .where('id', '=', op.entityId)
    .where('tenantId', '=', op.tenantId)
    .execute();
  await writeOrderLines(db, op, payload.lines);
};

export const orderPlacedApplier: Applier = async (db, op) => {
  await db
    .updateTable('purchasingOrders')
    .set({
      status: 'ordered',
      orderedBy: op.userId,
      orderedAt: op.timestamp,
      updatedAt: op.timestamp,
    })
    .where('id', '=', op.entityId)
    .where('tenantId', '=', op.tenantId)
    .execute();
};

export const orderCancelledApplier: Applier = async (db, op) => {
  const payload = payloadOf<{ readonly reason: string | null }>(op);
  await db
    .updateTable('purchasingOrders')
    .set({
      status: 'cancelled',
      cancelledBy: op.userId,
      cancelledAt: op.timestamp,
      cancelReason: payload.reason,
      updatedAt: op.timestamp,
    })
    .where('id', '=', op.entityId)
    .where('tenantId', '=', op.tenantId)
    .execute();
};

export const orderReceivedApplier: Applier = async (db, op) => {
  const payload = payloadOf<{
    readonly orderId: string;
    readonly note: string | null;
    readonly lines: readonly { readonly itemId: string; readonly qty: number }[];
  }>(op);
  await db
    .insertInto('purchasingReceipts')
    .values({
      id: op.entityId,
      tenantId: op.tenantId,
      storeId: op.storeId ?? '',
      orderId: payload.orderId,
      note: payload.note,
      userId: op.userId,
      at: op.timestamp,
    })
    .execute();
  await db
    .insertInto('purchasingReceiptLines')
    .values(
      payload.lines.map((line, position) => ({
        receiptId: op.entityId,
        position,
        tenantId: op.tenantId,
        orderId: payload.orderId,
        itemId: line.itemId,
        qty: line.qty,
      })),
    )
    .execute();
};
