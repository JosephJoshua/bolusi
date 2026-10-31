// The `purchasing` op rules, run by the device before saving and by the server before accepting a
// push (core module/op-rules.ts). Every read is constrained to the op's tenant, and orders to the
// op's store, so an op naming another business's supplier or another store's order finds nothing.
//
// - An order's lines change only while it is a draft; once Dipesan it is fixed, and only receiving
//   it or cancelling it changes it.
// - Only a placed order is received. A receipt a phone recorded before someone cancelled the order
//   (by phone time) still counts: the parts are on the shelf, so refusing it would leave the stock
//   wrong. Receiving more than was ordered is allowed (two phones offline, or the supplier sent
//   extra); the order then reads "Diterima lebih" for the owner to sort out once nothing is
//   still to come. An order that came in full cannot be cancelled.
// - An order number is the drafting device's own (shared/device-number.ts).
import type { Kysely } from 'kysely';

import { defineRefusals, type OpRule } from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';

import type { InventoryDatabase } from '../inventory/schema.js';
import { requireDeviceNumber } from '../shared/device-number.js';
import {
  PURCHASING_ORDER_ENTITY,
  PURCHASING_SUPPLIER_ENTITY,
  type OrderStatus,
} from './constants.js';
import { orderActions } from './order-form.js';
import { orderStage } from './queries.js';
import type { PurchasingDatabase } from './schema.js';

type Rule = OpRule<PurchasingDatabase>;
type Db = Parameters<Rule>[1]['db'];

/** Every reason a purchasing change is refused, each with copy at `purchasing.refusal.<reason>`. */
export const PURCHASING_REFUSALS = defineRefusals('purchasing', [
  'alreadyRecorded',
  'supplierNotFound',
  'orderNotFound',
  'itemNotFound',
  'notDraft',
  'notOrdered',
  'alreadyCancelled',
  'notOnOrder',
  'receiptMismatch',
  'nothingToCancel',
  'numberNotThisDevice',
  'numberUsed',
  // A command's own check: a draft names a part archived since it was written.
  'partArchived',
] as const);
const { refuse } = PURCHASING_REFUSALS;

function payloadOf<T>(op: SignedOperation): T {
  return op.payload as unknown as T;
}

function alreadyRecorded(field: string): Error {
  return refuse('alreadyRecorded', {
    code: 'VALIDATION_FAILED',
    details: { field, issue: 'already exists' },
  });
}

async function requireSupplier(db: Db, op: SignedOperation, supplierId: string): Promise<void> {
  const row = await db
    .selectFrom('purchasingSuppliers')
    .select('id')
    .where('id', '=', supplierId)
    .where('tenantId', '=', op.tenantId)
    .executeTakeFirst();
  if (row === undefined) {
    throw refuse('supplierNotFound', {
      code: 'ENTITY_NOT_FOUND',
      details: { entityType: PURCHASING_SUPPLIER_ENTITY, entityId: supplierId },
    });
  }
}

/** Every part on the lines is on this business's list (archived ones too: the list is history). */
async function requireItems(
  db: Db,
  op: SignedOperation,
  itemIds: readonly string[],
): Promise<void> {
  const found = await (db as unknown as Kysely<InventoryDatabase>)
    .selectFrom('inventoryItems')
    .select('id')
    .where('tenantId', '=', op.tenantId)
    .where('id', 'in', itemIds)
    .execute();
  const known = new Set(found.map((row) => row.id));
  const missing = itemIds.find((id) => !known.has(id));
  if (missing !== undefined) {
    throw refuse('itemNotFound', {
      code: 'ENTITY_NOT_FOUND',
      details: { entityType: 'inventory_item', entityId: missing },
    });
  }
}

/** The order, in the op's store. */
export async function requireOrder(db: Db, op: SignedOperation, orderId: string) {
  const order = await db
    .selectFrom('purchasingOrders')
    .select(['id', 'status', 'orderNumber', 'orderedAt', 'cancelledAt'])
    .where('id', '=', orderId)
    .where('tenantId', '=', op.tenantId)
    .where('storeId', '=', op.storeId ?? '')
    .executeTakeFirst();
  if (order === undefined) {
    throw refuse('orderNotFound', {
      code: 'ENTITY_NOT_FOUND',
      details: { entityType: PURCHASING_ORDER_ENTITY, entityId: orderId },
    });
  }
  return { ...order, status: order.status as OrderStatus };
}

async function requireDraft(db: Db, op: SignedOperation) {
  const order = await requireOrder(db, op, op.entityId);
  if (order.status !== 'draft') {
    throw refuse('notDraft', {
      details: { entityType: PURCHASING_ORDER_ENTITY, entityId: op.entityId },
      message: `order ${order.orderNumber} is ${order.status}`,
    });
  }
  return order;
}

interface OrderDetails {
  readonly supplierId: string;
  readonly lines: readonly { readonly itemId: string }[];
}

async function requireDetails(db: Db, op: SignedOperation): Promise<void> {
  const payload = payloadOf<OrderDetails>(op);
  await requireSupplier(db, op, payload.supplierId);
  await requireItems(
    db,
    op,
    payload.lines.map((line) => line.itemId),
  );
}

export const supplierAddedRule: Rule = async (op, { db }) => {
  const taken = await db
    .selectFrom('purchasingSuppliers')
    .select('id')
    .where('id', '=', op.entityId)
    .executeTakeFirst();
  if (taken !== undefined) throw alreadyRecorded('supplierId');
};

export const supplierEditedRule: Rule = async (op, { db }) => {
  await requireSupplier(db, op, op.entityId);
};

export const orderDraftedRule: Rule = async (op, { db }) => {
  const taken = await db
    .selectFrom('purchasingOrders')
    .select('id')
    .where('id', '=', op.entityId)
    .executeTakeFirst();
  if (taken !== undefined) throw alreadyRecorded('orderId');
  await requireDetails(db, op);
  // The number is printed on what goes to the supplier and labels the stock it brings: this
  // device's to mint offline, never another's, never twice.
  const { orderNumber } = payloadOf<{ readonly orderNumber: string }>(op);
  await requireDeviceNumber(db, op, {
    number: orderNumber,
    prefix: 'PO-',
    table: 'purchasing_orders',
    column: 'order_number',
    notThisDevice: () =>
      refuse('numberNotThisDevice', {
        code: 'VALIDATION_FAILED',
        details: { field: 'orderNumber', issue: 'not minted by this device' },
        message: `order number ${orderNumber} does not belong to device ${op.deviceId}`,
      }),
    used: () =>
      refuse('numberUsed', {
        code: 'VALIDATION_FAILED',
        details: { field: 'orderNumber', issue: 'already used' },
        message: `order number ${orderNumber} is already used by this device`,
      }),
  });
};

export const orderEditedRule: Rule = async (op, { db }) => {
  await requireDraft(db, op);
  await requireDetails(db, op);
};

export const orderPlacedRule: Rule = async (op, { db }) => {
  await requireDraft(db, op);
};

export const orderCancelledRule: Rule = async (op, { db }) => {
  const order = await requireOrder(db, op, op.entityId);
  if (order.status === 'cancelled') {
    throw refuse('alreadyCancelled', {
      details: { entityType: PURCHASING_ORDER_ENTITY, entityId: op.entityId },
    });
  }
  // Once every part came there is nothing to stop waiting for, and an order that came over keeps
  // saying so until the owner corrects the stock.
  // The same stage and actions the screens offer, so the device never offers a cancel refused here.
  if (
    order.status === 'ordered' &&
    !orderActions(orderStage(order.status, await linesArrived(db, op, order.id))).includes('cancel')
  ) {
    throw refuse('nothingToCancel', {
      details: { entityType: PURCHASING_ORDER_ENTITY, entityId: op.entityId },
      message: `order ${order.orderNumber} has arrived in full`,
    });
  }
};

/** Each line of the order with what has arrived of it. */
async function linesArrived(
  db: Db,
  op: SignedOperation,
  orderId: string,
): Promise<{ readonly qty: number; readonly received: number }[]> {
  const lines = await db
    .selectFrom('purchasingOrderLines')
    .select(['itemId', 'qty'])
    .where('tenantId', '=', op.tenantId)
    .where('orderId', '=', orderId)
    .execute();
  const came = await db
    .selectFrom('purchasingReceiptLines as l')
    .innerJoin('purchasingReceipts as r', 'r.id', 'l.receiptId')
    .select(['l.itemId', (eb) => eb.fn.sum<number>('l.qty').as('qty')])
    .where('r.tenantId', '=', op.tenantId)
    .where('r.orderId', '=', orderId)
    .groupBy('l.itemId')
    .execute();
  const arrived = new Map(came.map((row) => [row.itemId, Number(row.qty)]));
  return lines.map((line) => ({ qty: line.qty, received: arrived.get(line.itemId) ?? 0 }));
}

export const orderReceivedRule: Rule = async (op, { db }) => {
  const taken = await db
    .selectFrom('purchasingReceipts')
    .select('id')
    .where('id', '=', op.entityId)
    .executeTakeFirst();
  if (taken !== undefined) throw alreadyRecorded('receiptId');
  const payload = payloadOf<{
    readonly orderId: string;
    readonly lines: readonly { readonly itemId: string }[];
  }>(op);
  const order = await requireOrder(db, op, payload.orderId);
  // Only an order that was placed, received while it still stood.
  const receivedBeforeCancel =
    order.status === 'cancelled' &&
    order.orderedAt !== null &&
    order.cancelledAt !== null &&
    op.timestamp >= Number(order.orderedAt) &&
    op.timestamp < Number(order.cancelledAt);
  if (order.status !== 'ordered' && !receivedBeforeCancel) {
    throw refuse('notOrdered', {
      details: { entityType: PURCHASING_ORDER_ENTITY, entityId: payload.orderId },
      message: `order ${order.orderNumber} is ${order.status}`,
    });
  }
  const onOrder = new Set(
    (
      await db
        .selectFrom('purchasingOrderLines')
        .select('itemId')
        .where('orderId', '=', payload.orderId)
        .where('tenantId', '=', op.tenantId)
        .execute()
    ).map((row) => row.itemId),
  );
  const extra = payload.lines.find((line) => !onOrder.has(line.itemId));
  if (extra !== undefined) {
    throw refuse('notOnOrder', {
      code: 'VALIDATION_FAILED',
      details: { field: 'lines', issue: `${extra.itemId} is not on the order` },
    });
  }
};
