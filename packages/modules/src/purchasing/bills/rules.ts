// The bill rules, run on the device before saving and on the server before accepting a push.
//
// - A bill names a supplier of this business and parts on its list. When it bills an order, that
//   order is this store's, placed (a draft has nothing to bill yet), and from the same supplier.
//   It may bill more or less than arrived: a nota can come before the parts, or bill only some.
//   The screens show the difference; nothing here refuses it.
// - A void bill stays as history and is never edited or voided again.
// - A bill number is the recording device's own (shared/device-number.ts).
import type { SignedOperation } from '@bolusi/schemas';

import { PURCHASING_BILL_ENTITY, PURCHASING_ORDER_ENTITY } from '../constants.js';
import {
  PURCHASING_REFUSALS,
  alreadyRecorded,
  requireItems,
  requireOrder,
  requireSupplier,
} from '../rules.js';
import { requireDeviceNumber } from '../../shared/device-number.js';
import type { BillDetails } from './applier.js';
import type { OpRule } from '@bolusi/core';
import type { PurchasingDatabase } from '../schema.js';

type Rule = OpRule<PurchasingDatabase>;
type Db = Parameters<Rule>[1]['db'];

const { refuse } = PURCHASING_REFUSALS;

function payloadOf<T>(op: SignedOperation): T {
  return op.payload as unknown as T;
}

/** The bill, in the op's store, still standing. */
async function requireOpenBill(db: Db, op: SignedOperation) {
  const bill = await db
    .selectFrom('purchasingBills')
    .select(['id', 'status', 'billNumber'])
    .where('id', '=', op.entityId)
    .where('tenantId', '=', op.tenantId)
    .where('storeId', '=', op.storeId ?? '')
    .executeTakeFirst();
  if (bill === undefined) {
    throw refuse('billNotFound', {
      code: 'ENTITY_NOT_FOUND',
      details: { entityType: PURCHASING_BILL_ENTITY, entityId: op.entityId },
    });
  }
  if (bill.status === 'void') {
    throw refuse('billVoid', {
      details: { entityType: PURCHASING_BILL_ENTITY, entityId: op.entityId },
      message: `bill ${bill.billNumber} is void`,
    });
  }
  return bill;
}

async function requireDetails(db: Db, op: SignedOperation): Promise<void> {
  const payload = payloadOf<BillDetails>(op);
  await requireSupplier(db, op, payload.supplierId);
  await requireItems(
    db,
    op,
    payload.lines.map((line) => line.itemId),
  );
  if (payload.orderId === null) return;
  const order = await requireOrder(db, op, payload.orderId);
  if (order.status === 'draft') {
    throw refuse('orderNotPlaced', {
      details: { entityType: PURCHASING_ORDER_ENTITY, entityId: payload.orderId },
      message: `order ${order.orderNumber} is still a draft`,
    });
  }
  const supplier = await db
    .selectFrom('purchasingOrders')
    .select('supplierId')
    .where('id', '=', payload.orderId)
    .where('tenantId', '=', op.tenantId)
    .executeTakeFirstOrThrow();
  if (supplier.supplierId !== payload.supplierId) {
    throw refuse('orderOtherSupplier', {
      code: 'VALIDATION_FAILED',
      details: { field: 'orderId', issue: 'ordered from another supplier' },
    });
  }
}

export const billRecordedRule: Rule = async (op, { db }) => {
  const taken = await db
    .selectFrom('purchasingBills')
    .select('id')
    .where('id', '=', op.entityId)
    .executeTakeFirst();
  if (taken !== undefined) throw alreadyRecorded('billId');
  await requireDetails(db, op);
  const { billNumber } = payloadOf<{ readonly billNumber: string }>(op);
  await requireDeviceNumber(db, op, {
    number: billNumber,
    prefix: 'TG-',
    table: 'purchasing_bills',
    column: 'bill_number',
    notThisDevice: () =>
      refuse('billNumberNotThisDevice', {
        code: 'VALIDATION_FAILED',
        details: { field: 'billNumber', issue: 'not minted by this device' },
        message: `bill number ${billNumber} does not belong to device ${op.deviceId}`,
      }),
    used: () =>
      refuse('billNumberUsed', {
        code: 'VALIDATION_FAILED',
        details: { field: 'billNumber', issue: 'already used' },
        message: `bill number ${billNumber} is already used by this device`,
      }),
  });
};

export const billEditedRule: Rule = async (op, { db }) => {
  await requireOpenBill(db, op);
  await requireDetails(db, op);
};

export const billVoidedRule: Rule = async (op, { db }) => {
  await requireOpenBill(db, op);
};
