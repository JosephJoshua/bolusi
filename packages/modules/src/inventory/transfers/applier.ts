// The transfer projection appliers and table manifests. A transfer's row (and its lines) is keyed
// to the transfer, an arrival's to the arrival, a settlement's to the settlement, so the receiving
// store recording an arrival and the sending owner settling never rewrite each other's rows.
// Appliers stay total: the rules refuse what must not be recorded.
import type { ProjectionApplier, ProjectionOperation, ProjectionTableManifest } from '@bolusi/core';

import {
  INVENTORY_TRANSFER_ARRIVAL_ENTITY,
  INVENTORY_TRANSFER_ENTITY,
  INVENTORY_TRANSFER_SETTLEMENT_ENTITY,
} from '../constants.js';
import type { InventoryDatabase } from '../schema.js';

type Applier = ProjectionApplier<InventoryDatabase>;

export const inventoryTransfersTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    to_store_id: 'text',
    transfer_number: 'text',
    note: 'text',
    sent_by: 'text',
    sent_at: 'integer',
    cancelled_by: 'text',
    cancelled_at: 'integer',
    cancel_reason: 'text',
  },
  primaryKey: ['id'],
  entityType: INVENTORY_TRANSFER_ENTITY,
  entityIdColumn: 'id',
  projectionVersion: 1,
};

export const inventoryTransferLinesTable: ProjectionTableManifest = {
  columns: {
    transfer_id: 'text',
    position: 'integer',
    tenant_id: 'text',
    item_id: 'text',
    item_name: 'text',
    qty: 'integer',
  },
  primaryKey: ['transfer_id', 'position'],
  entityType: INVENTORY_TRANSFER_ENTITY,
  entityIdColumn: 'transfer_id',
  projectionVersion: 1,
};

export const inventoryTransferArrivalsTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    transfer_id: 'text',
    note: 'text',
    user_id: 'text',
    at: 'integer',
  },
  primaryKey: ['id'],
  entityType: INVENTORY_TRANSFER_ARRIVAL_ENTITY,
  entityIdColumn: 'id',
  projectionVersion: 1,
};

export const inventoryTransferArrivalLinesTable: ProjectionTableManifest = {
  columns: {
    arrival_id: 'text',
    position: 'integer',
    tenant_id: 'text',
    transfer_id: 'text',
    item_id: 'text',
    qty: 'integer',
  },
  primaryKey: ['arrival_id', 'position'],
  entityType: INVENTORY_TRANSFER_ARRIVAL_ENTITY,
  entityIdColumn: 'arrival_id',
  projectionVersion: 1,
};

export const inventoryTransferSettlementsTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    transfer_id: 'text',
    reason: 'text',
    user_id: 'text',
    at: 'integer',
  },
  primaryKey: ['id'],
  entityType: INVENTORY_TRANSFER_SETTLEMENT_ENTITY,
  entityIdColumn: 'id',
  projectionVersion: 1,
};

export const inventoryTransferSettlementLinesTable: ProjectionTableManifest = {
  columns: {
    settlement_id: 'text',
    position: 'integer',
    tenant_id: 'text',
    transfer_id: 'text',
    item_id: 'text',
    outcome: 'text',
    qty: 'integer',
  },
  primaryKey: ['settlement_id', 'position'],
  entityType: INVENTORY_TRANSFER_SETTLEMENT_ENTITY,
  entityIdColumn: 'settlement_id',
  projectionVersion: 1,
};

function payloadOf<T>(op: ProjectionOperation): T {
  return op.payload as unknown as T;
}

export const transferSentApplier: Applier = async (db, op) => {
  const payload = payloadOf<{
    transferNumber: string;
    toStoreId: string;
    note: string | null;
    lines: readonly { itemId: string; name: string; qty: number }[];
  }>(op);
  await db
    .insertInto('inventoryTransfers')
    .values({
      id: op.entityId,
      tenantId: op.tenantId,
      // Transfer ops are store-scoped, so the store is always stamped.
      storeId: op.storeId ?? '',
      toStoreId: payload.toStoreId,
      transferNumber: payload.transferNumber,
      note: payload.note,
      sentBy: op.userId,
      sentAt: op.timestamp,
      cancelledBy: null,
      cancelledAt: null,
      cancelReason: null,
    })
    .execute();
  await db
    .insertInto('inventoryTransferLines')
    .values(
      payload.lines.map((line, position) => ({
        transferId: op.entityId,
        position,
        tenantId: op.tenantId,
        itemId: line.itemId,
        itemName: line.name,
        qty: line.qty,
      })),
    )
    .execute();
};

export const transferCancelledApplier: Applier = async (db, op) => {
  const payload = payloadOf<{ reason: string | null }>(op);
  await db
    .updateTable('inventoryTransfers')
    .set({ cancelledBy: op.userId, cancelledAt: op.timestamp, cancelReason: payload.reason })
    .where('id', '=', op.entityId)
    .where('tenantId', '=', op.tenantId)
    .execute();
};

export const transferReceivedApplier: Applier = async (db, op) => {
  const payload = payloadOf<{
    transferId: string;
    note: string | null;
    lines: readonly { itemId: string; qty: number }[];
  }>(op);
  await db
    .insertInto('inventoryTransferArrivals')
    .values({
      id: op.entityId,
      tenantId: op.tenantId,
      storeId: op.storeId ?? '',
      transferId: payload.transferId,
      note: payload.note,
      userId: op.userId,
      at: op.timestamp,
    })
    .execute();
  await db
    .insertInto('inventoryTransferArrivalLines')
    .values(
      payload.lines.map((line, position) => ({
        arrivalId: op.entityId,
        position,
        tenantId: op.tenantId,
        transferId: payload.transferId,
        itemId: line.itemId,
        qty: line.qty,
      })),
    )
    .execute();
};

export const transferSettledApplier: Applier = async (db, op) => {
  const payload = payloadOf<{
    transferId: string;
    reason: string | null;
    lines: readonly { itemId: string; outcome: string; qty: number }[];
  }>(op);
  await db
    .insertInto('inventoryTransferSettlements')
    .values({
      id: op.entityId,
      tenantId: op.tenantId,
      storeId: op.storeId ?? '',
      transferId: payload.transferId,
      reason: payload.reason,
      userId: op.userId,
      at: op.timestamp,
    })
    .execute();
  await db
    .insertInto('inventoryTransferSettlementLines')
    .values(
      payload.lines.map((line, position) => ({
        settlementId: op.entityId,
        position,
        tenantId: op.tenantId,
        transferId: payload.transferId,
        itemId: line.itemId,
        outcome: line.outcome,
        qty: line.qty,
      })),
    )
    .execute();
};
