// The supplier payment rules, run on the device before saving and on the server before accepting a
// push.
//
// - A payment names a supplier of this business. When it names a bill, that bill is this store's,
//   standing, and the same supplier's. Paying more than a bill still owes is allowed: the rest is
//   the supplier's credit (balances.ts), as money paid ahead of any bill is.
// - It comes from the drawer, one of the store's bank (transfer) accounts, or the owner's own money.
// - A cancelled payment stays as history and is never cancelled again. One paid from the drawer is
//   not cancelled once a later count of that drawer was settled: the owner already put that book
//   right, and the drawer's side (money.supplier_payment_voided) would be refused.
import type { Kysely } from 'kysely';

import type { OpRule } from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';

import { CASH_ACCOUNT, paymentAccountIdOf } from '../../money/constants.js';
import { settledCountAfter, usableAccount } from '../../money/rules.js';
import type { MoneyDatabase } from '../../money/schema.js';
import { PURCHASING_BILL_ENTITY, PURCHASING_PAYMENT_ENTITY, OWNER_FUNDS } from '../constants.js';
import { PURCHASING_REFUSALS, alreadyRecorded, requireSupplier } from '../rules.js';
import type { PurchasingDatabase } from '../schema.js';
import type { PaymentDetails } from './applier.js';

type Rule = OpRule<PurchasingDatabase>;
type Db = Parameters<Rule>[1]['db'];

const { refuse } = PURCHASING_REFUSALS;

function payloadOf<T>(op: SignedOperation): T {
  return op.payload as unknown as T;
}

async function requireBill(db: Db, op: SignedOperation, billId: string, supplierId: string) {
  const bill = await db
    .selectFrom('purchasingBills')
    .select(['status', 'billNumber', 'supplierId'])
    .where('id', '=', billId)
    .where('tenantId', '=', op.tenantId)
    .where('storeId', '=', op.storeId ?? '')
    .executeTakeFirst();
  if (bill === undefined) {
    throw refuse('billNotFound', {
      code: 'ENTITY_NOT_FOUND',
      details: { entityType: PURCHASING_BILL_ENTITY, entityId: billId },
    });
  }
  if (bill.status === 'void') {
    throw refuse('billVoid', {
      details: { entityType: PURCHASING_BILL_ENTITY, entityId: billId },
      message: `bill ${bill.billNumber} is void`,
    });
  }
  if (bill.supplierId !== supplierId) {
    throw refuse('billOtherSupplier', {
      code: 'VALIDATION_FAILED',
      details: { field: 'billId', issue: "another supplier's bill" },
    });
  }
}

/** The drawer, the owner's money, or a bank account this store uses. */
async function requireSource(db: Db, op: SignedOperation, source: string): Promise<void> {
  if (source === CASH_ACCOUNT || source === OWNER_FUNDS) return;
  const accountId = paymentAccountIdOf(source);
  const account =
    accountId === null
      ? null
      : await usableAccount(
          db as unknown as Kysely<MoneyDatabase>,
          op.tenantId,
          op.storeId ?? '',
          accountId,
        );
  if (account?.kind !== 'transfer') {
    throw refuse('sourceNotUsable', {
      code: 'VALIDATION_FAILED',
      details: { field: 'source', issue: 'not a bank account this store uses' },
    });
  }
}

export const supplierPaidRule: Rule = async (op, { db }) => {
  const taken = await db
    .selectFrom('purchasingPayments')
    .select('id')
    .where('id', '=', op.entityId)
    .executeTakeFirst();
  if (taken !== undefined) throw alreadyRecorded('paymentId');
  const payload = payloadOf<PaymentDetails>(op);
  await requireSupplier(db, op, payload.supplierId);
  if (payload.billId !== null) await requireBill(db, op, payload.billId, payload.supplierId);
  await requireSource(db, op, payload.source);
};

export const supplierPaymentVoidedRule: Rule = async (op, { db }) => {
  const payment = await db
    .selectFrom('purchasingPayments')
    .select(['source', 'createdAt', 'voidedAt'])
    .where('id', '=', op.entityId)
    .where('tenantId', '=', op.tenantId)
    .where('storeId', '=', op.storeId ?? '')
    .executeTakeFirst();
  if (payment === undefined) {
    throw refuse('paymentNotFound', {
      code: 'ENTITY_NOT_FOUND',
      details: { entityType: PURCHASING_PAYMENT_ENTITY, entityId: op.entityId },
    });
  }
  if (payment.voidedAt !== null) {
    throw refuse('paymentVoided', {
      details: { entityType: PURCHASING_PAYMENT_ENTITY, entityId: op.entityId },
    });
  }
  if (
    payment.source === CASH_ACCOUNT &&
    (await settledCountAfter(
      db as unknown as Kysely<MoneyDatabase>,
      op.storeId ?? '',
      Number(payment.createdAt),
    ))
  ) {
    throw refuse('drawerSettled', {
      code: 'INVALID_TRANSITION',
      details: { entityType: PURCHASING_PAYMENT_ENTITY, entityId: op.entityId },
    });
  }
};
