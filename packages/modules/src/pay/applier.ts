// The `pay` projection appliers and table manifests. Terms and store rates are history, one row per
// change keyed by the op; kasbon, repayments, payouts and adjustments are each their own entity,
// recorded once and cancelled by a second op on the same entity, so the history keeps both.
// Appliers stay total: the rules refuse what must not be recorded, and whatever the server
// accepted still folds.
import type { ProjectionApplier, ProjectionOperation, ProjectionTableManifest } from '@bolusi/core';

import {
  PAY_ADJUSTMENT_ENTITY,
  PAY_ADVANCE_ENTITY,
  PAY_EMPLOYEE_ENTITY,
  PAY_PAYOUT_ENTITY,
  PAY_REPAYMENT_ENTITY,
  PAY_STORE_ENTITY,
} from './constants.js';
import type { PayDatabase } from './schema.js';

type Applier = ProjectionApplier<PayDatabase>;

const VOID_COLUMNS = { voided_by: 'text', voided_at: 'integer', void_reason: 'text' } as const;

export const payTermsTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    user_id: 'text',
    salary: 'integer',
    commission_percent: 'integer',
    set_by: 'text',
    set_at: 'integer',
  },
  primaryKey: ['id'],
  entityType: PAY_EMPLOYEE_ENTITY,
  entityIdColumn: 'user_id',
  projectionVersion: 1,
};

export const payStoreRatesTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    commission_percent: 'integer',
    set_by: 'text',
    set_at: 'integer',
  },
  primaryKey: ['id'],
  entityType: PAY_STORE_ENTITY,
  entityIdColumn: 'store_id',
  projectionVersion: 1,
};

export const payAdvancesTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    user_id: 'text',
    amount: 'integer',
    account: 'text',
    reason: 'text',
    installment: 'integer',
    created_by: 'text',
    created_at: 'integer',
    ...VOID_COLUMNS,
  },
  primaryKey: ['id'],
  entityType: PAY_ADVANCE_ENTITY,
  entityIdColumn: 'id',
  projectionVersion: 1,
};

export const payRepaymentsTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    user_id: 'text',
    amount: 'integer',
    via: 'text',
    payout_id: 'text',
    note: 'text',
    created_by: 'text',
    created_at: 'integer',
    ...VOID_COLUMNS,
  },
  primaryKey: ['id'],
  entityType: PAY_REPAYMENT_ENTITY,
  entityIdColumn: 'id',
  projectionVersion: 1,
};

export const payPayoutsTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    user_id: 'text',
    month: 'text',
    salary: 'integer',
    commission: 'integer',
    deduction: 'integer',
    repayment_id: 'text',
    paid: 'integer',
    account: 'text',
    note: 'text',
    created_by: 'text',
    created_at: 'integer',
    ...VOID_COLUMNS,
  },
  primaryKey: ['id'],
  entityType: PAY_PAYOUT_ENTITY,
  entityIdColumn: 'id',
  projectionVersion: 1,
};

export const payAdjustmentsTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    user_id: 'text',
    amount: 'integer',
    reason: 'text',
    created_by: 'text',
    created_at: 'integer',
  },
  primaryKey: ['id'],
  entityType: PAY_ADJUSTMENT_ENTITY,
  entityIdColumn: 'id',
  projectionVersion: 1,
};

function payloadOf<T>(op: ProjectionOperation): T {
  return op.payload as unknown as T;
}

/** Pay ops are store-scoped, so the store is always stamped. */
function storeOf(op: ProjectionOperation): string {
  return op.storeId ?? '';
}

const notVoided = { voidedBy: null, voidedAt: null, voidReason: null } as const;

export const termsSetApplier: Applier = async (db, op) => {
  const payload = payloadOf<{ salary: number; commissionPercent: number | null }>(op);
  await db
    .insertInto('payTerms')
    .values({
      id: op.id,
      tenantId: op.tenantId,
      storeId: storeOf(op),
      userId: op.entityId,
      salary: payload.salary,
      commissionPercent: payload.commissionPercent,
      setBy: op.userId,
      setAt: op.timestamp,
    })
    .execute();
};

export const storeCommissionSetApplier: Applier = async (db, op) => {
  const payload = payloadOf<{ commissionPercent: number | null }>(op);
  await db
    .insertInto('payStoreRates')
    .values({
      id: op.id,
      tenantId: op.tenantId,
      storeId: op.entityId,
      commissionPercent: payload.commissionPercent,
      setBy: op.userId,
      setAt: op.timestamp,
    })
    .execute();
};

export const advanceGrantedApplier: Applier = async (db, op) => {
  const payload = payloadOf<{
    userId: string;
    amount: number;
    account: string;
    reason: string;
    installment: number;
  }>(op);
  await db
    .insertInto('payAdvances')
    .values({
      id: op.entityId,
      tenantId: op.tenantId,
      storeId: storeOf(op),
      userId: payload.userId,
      amount: payload.amount,
      account: payload.account,
      reason: payload.reason,
      installment: payload.installment,
      createdBy: op.userId,
      createdAt: op.timestamp,
      ...notVoided,
    })
    .execute();
};

export const advanceSettledApplier: Applier = async (db, op) => {
  const payload = payloadOf<{
    userId: string;
    amount: number;
    via: string;
    payoutId: string | null;
    note: string | null;
  }>(op);
  await db
    .insertInto('payRepayments')
    .values({
      id: op.entityId,
      tenantId: op.tenantId,
      storeId: storeOf(op),
      userId: payload.userId,
      amount: payload.amount,
      via: payload.via,
      payoutId: payload.payoutId,
      note: payload.note,
      createdBy: op.userId,
      createdAt: op.timestamp,
      ...notVoided,
    })
    .execute();
};

export const paidApplier: Applier = async (db, op) => {
  const payload = payloadOf<{
    userId: string;
    month: string;
    salary: number;
    commission: number;
    deduction: number;
    repaymentId: string | null;
    paid: number;
    account: string;
    note: string | null;
  }>(op);
  await db
    .insertInto('payPayouts')
    .values({
      id: op.entityId,
      tenantId: op.tenantId,
      storeId: storeOf(op),
      userId: payload.userId,
      month: payload.month,
      salary: payload.salary,
      commission: payload.commission,
      deduction: payload.deduction,
      repaymentId: payload.repaymentId,
      paid: payload.paid,
      account: payload.account,
      note: payload.note,
      createdBy: op.userId,
      createdAt: op.timestamp,
      ...notVoided,
    })
    .execute();
};

export const commissionAdjustedApplier: Applier = async (db, op) => {
  const payload = payloadOf<{ userId: string; amount: number; reason: string }>(op);
  await db
    .insertInto('payAdjustments')
    .values({
      id: op.entityId,
      tenantId: op.tenantId,
      storeId: storeOf(op),
      userId: payload.userId,
      amount: payload.amount,
      reason: payload.reason,
      createdBy: op.userId,
      createdAt: op.timestamp,
    })
    .execute();
};

/** A cancel marks its record; a second cancel (two owners, offline) changes nothing. */
function voidApplier(table: 'payAdvances' | 'payRepayments' | 'payPayouts'): Applier {
  return async (db, op) => {
    const { reason } = payloadOf<{ reason: string }>(op);
    await db
      .updateTable(table)
      .set({ voidedBy: op.userId, voidedAt: op.timestamp, voidReason: reason })
      .where('id', '=', op.entityId)
      .where('tenantId', '=', op.tenantId)
      .where('voidedAt', 'is', null)
      .execute();
  };
}

export const advanceVoidedApplier = voidApplier('payAdvances');
export const repaymentVoidedApplier = voidApplier('payRepayments');
export const payoutVoidedApplier = voidApplier('payPayouts');
