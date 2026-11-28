// The `pay` rules, run on the device before saving and on the server before accepting a push
// (product-scope.md, "Staff pay").
//
// - Terms, rates and pay go only to people who work at the store (every role holds `pay.own`).
// - Nobody hands themselves a kasbon or pays themselves.
// - Kasbon comes from the drawer or a bank account the store uses, and its installment is never
//   more than it. Kasbon comes back only up to what is open; writing it off is the owners'.
// - One payout per person per month, for a month around now. Its salary is never more than the set
//   salary; its commission never more than the server's own figure (commission.ts), and a take-back
//   never more than what is owed back; its kasbon installment never more than the balance; what
//   leaves the account is exactly salary + commission − installment, never below zero.
// - A payout's installment is a repayment of its own, recorded with it and only as it says.
// - A cancel stays as history and is never cancelled again. One paid from the drawer is not
//   cancelled once a later count of that drawer was settled: the owner already put that book right.
import type { Kysely } from 'kysely';

import { defineRefusals, type OpRule } from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';

import { CASH_ACCOUNT, paymentAccountIdOf } from '../money/constants.js';
import { settledCountAfter, usableAccount } from '../money/rules.js';
import type { MoneyDatabase } from '../money/schema.js';
import { advanceBalance } from './advances.js';
import { commissionBalance, type CommissionDb } from './commission.js';
import {
  MONTH_PATTERN,
  PAY_ADVANCE_ENTITY,
  PAY_PAYOUT_ENTITY,
  PAY_PERMISSION,
  PAY_REPAYMENT_ENTITY,
  SALARY_REPAYMENT,
  WRITTEN_OFF,
} from './constants.js';
import type { PayDatabase } from './schema.js';

type Rule = OpRule<PayDatabase>;
type Db = Parameters<Rule>[1]['db'];

/** Every reason a pay change is refused, each with copy at `pay.refusal.<reason>`. */
export const PAY_REFUSALS = defineRefusals('pay', [
  'notStaff',
  'self',
  'alreadyRecorded',
  'accountNotUsable',
  'installmentAboveAmount',
  'aboveBalance',
  'advanceNotFound',
  'advanceSettled',
  'repaymentNotFound',
  'repaymentNotAsPayout',
  'payoutNotFound',
  'alreadyVoided',
  'drawerSettled',
  'monthPaid',
  'monthOutOfRange',
  'salaryAboveTerms',
  'commissionAboveOwed',
  'paidNotTotal',
  'zeroAdjustment',
  'writeOffOwners',
  'otherStore',
] as const);
const { refuse } = PAY_REFUSALS;

function payloadOf<T>(op: SignedOperation): T {
  return op.payload as unknown as T;
}

function scopeOf(op: SignedOperation) {
  return { tenantId: op.tenantId, storeId: op.storeId ?? '' };
}

/** Someone who works at this store: every role there holds `pay.own`. */
async function requireStaff(ctx: Parameters<Rule>[1], userId: string): Promise<void> {
  if (await ctx.holdsPermission(userId, PAY_PERMISSION.own, { uses: false })) return;
  throw refuse('notStaff', {
    code: 'VALIDATION_FAILED',
    details: { field: 'userId', issue: 'does not work at this store' },
  });
}

function requireOther(op: SignedOperation, userId: string): void {
  if (userId !== op.userId) return;
  throw refuse('self', {
    code: 'PERMISSION_DENIED',
    details: { field: 'userId', issue: 'their own pay' },
  });
}

/** The drawer, or a bank (transfer) account this store uses. */
export async function requirePayAccount(
  db: Db,
  op: SignedOperation,
  account: string,
): Promise<void> {
  if (account === CASH_ACCOUNT) return;
  const accountId = paymentAccountIdOf(account);
  const found =
    accountId === null
      ? null
      : await usableAccount(
          db as unknown as Kysely<MoneyDatabase>,
          op.tenantId,
          op.storeId ?? '',
          accountId,
        );
  if (found?.kind !== 'transfer') {
    throw refuse('accountNotUsable', {
      code: 'VALIDATION_FAILED',
      details: { field: 'account', issue: 'not the drawer or a bank account this store uses' },
    });
  }
}

async function requireNew(
  db: Db,
  table: 'payAdvances' | 'payRepayments' | 'payPayouts' | 'payAdjustments',
  op: SignedOperation,
): Promise<void> {
  const taken = await db
    .selectFrom(table)
    .select('id')
    .where('id', '=', op.entityId)
    .executeTakeFirst();
  if (taken !== undefined) {
    throw refuse('alreadyRecorded', {
      code: 'VALIDATION_FAILED',
      details: { field: 'id', issue: 'already exists' },
    });
  }
}

/** Not once a later count of the drawer it came from or went into was settled. */
async function requireDrawerOpen(
  db: Db,
  op: SignedOperation,
  account: string,
  at: number,
  entityType: string,
): Promise<void> {
  if (account !== CASH_ACCOUNT) return;
  if (await settledCountAfter(db as unknown as Kysely<MoneyDatabase>, op.storeId ?? '', at)) {
    throw refuse('drawerSettled', {
      code: 'INVALID_TRANSITION',
      details: { entityType, entityId: op.entityId },
    });
  }
}

// ── terms ────────────────────────────────────────────────────────────────────────────────────

export const termsSetRule: Rule = async (op, ctx) => {
  requireOther(op, op.entityId);
  await requireStaff(ctx, op.entityId);
};

/** A store's commission is set at that store only. */
export const storeCommissionSetRule: Rule = async (op) => {
  if (op.entityId === op.storeId) return;
  throw refuse('otherStore', {
    code: 'VALIDATION_FAILED',
    details: { field: 'entityId', issue: 'not this store' },
  });
};

// ── kasbon ───────────────────────────────────────────────────────────────────────────────────

export const advanceGrantedRule: Rule = async (op, ctx) => {
  const payload = payloadOf<{
    userId: string;
    amount: number;
    account: string;
    installment: number;
  }>(op);
  await requireNew(ctx.db, 'payAdvances', op);
  requireOther(op, payload.userId);
  await requireStaff(ctx, payload.userId);
  await requirePayAccount(ctx.db, op, payload.account);
  if (payload.installment > payload.amount) {
    throw refuse('installmentAboveAmount', {
      code: 'VALIDATION_FAILED',
      details: { field: 'installment', issue: `at most ${payload.amount}` },
    });
  }
};

export const advanceSettledRule: Rule = async (op, ctx) => {
  const payload = payloadOf<{
    userId: string;
    amount: number;
    via: string;
    payoutId: string | null;
  }>(op);
  await requireNew(ctx.db, 'payRepayments', op);
  if (payload.via === SALARY_REPAYMENT) {
    // Only as its payout says: the payout is recorded first, in the same command.
    const payout =
      payload.payoutId === null
        ? undefined
        : await ctx.db
            .selectFrom('payPayouts')
            .select(['userId', 'deduction', 'repaymentId', 'voidedAt', 'createdBy'])
            .where('id', '=', payload.payoutId)
            .where('tenantId', '=', op.tenantId)
            .where('storeId', '=', op.storeId ?? '')
            .executeTakeFirst();
    if (
      payout === undefined ||
      payout.voidedAt !== null ||
      payout.repaymentId !== op.entityId ||
      payout.userId !== payload.userId ||
      Number(payout.deduction) !== payload.amount ||
      payout.createdBy !== op.userId
    ) {
      throw refuse('repaymentNotAsPayout', {
        code: 'VALIDATION_FAILED',
        details: { field: 'payoutId', issue: 'not as the payout says' },
      });
    }
    // The payout's rule already held its installment to the balance before this was taken off.
    return;
  }
  if (payload.payoutId !== null) {
    throw refuse('repaymentNotAsPayout', {
      code: 'VALIDATION_FAILED',
      details: { field: 'payoutId', issue: 'only an installment off a payout names one' },
    });
  }
  if (payload.via === WRITTEN_OFF) {
    if (!(await ctx.holdsPermission(op.userId, PAY_PERMISSION.manage))) {
      throw refuse('writeOffOwners', {
        code: 'PERMISSION_DENIED',
        details: { permissionId: PAY_PERMISSION.manage },
      });
    }
  } else {
    await requirePayAccount(ctx.db, op, payload.via);
  }
  const { balance } = await advanceBalance(ctx.db, scopeOf(op), payload.userId);
  if (payload.amount > balance) {
    throw refuse('aboveBalance', {
      code: 'VALIDATION_FAILED',
      details: { field: 'amount', issue: `at most ${balance}` },
    });
  }
};

export const advanceVoidedRule: Rule = async (op, { db }) => {
  const advance = await db
    .selectFrom('payAdvances')
    .select(['userId', 'amount', 'account', 'createdAt', 'voidedAt'])
    .where('id', '=', op.entityId)
    .where('tenantId', '=', op.tenantId)
    .where('storeId', '=', op.storeId ?? '')
    .executeTakeFirst();
  if (advance === undefined) {
    throw refuse('advanceNotFound', {
      code: 'ENTITY_NOT_FOUND',
      details: { entityType: PAY_ADVANCE_ENTITY, entityId: op.entityId },
    });
  }
  if (advance.voidedAt !== null) {
    throw refuse('alreadyVoided', { details: { entityId: op.entityId } });
  }
  // Only while nothing has come back off it: then the balance still holds all of it.
  const { balance } = await advanceBalance(db, scopeOf(op), advance.userId);
  if (balance < Number(advance.amount)) {
    throw refuse('advanceSettled', {
      details: { entityType: PAY_ADVANCE_ENTITY, entityId: op.entityId },
    });
  }
  await requireDrawerOpen(db, op, advance.account, Number(advance.createdAt), PAY_ADVANCE_ENTITY);
};

export const repaymentVoidedRule: Rule = async (op, { db }) => {
  const repayment = await db
    .selectFrom('payRepayments')
    .select(['via', 'payoutId', 'createdAt', 'voidedAt'])
    .where('id', '=', op.entityId)
    .where('tenantId', '=', op.tenantId)
    .where('storeId', '=', op.storeId ?? '')
    .executeTakeFirst();
  if (repayment === undefined) {
    throw refuse('repaymentNotFound', {
      code: 'ENTITY_NOT_FOUND',
      details: { entityType: PAY_REPAYMENT_ENTITY, entityId: op.entityId },
    });
  }
  if (repayment.voidedAt !== null) {
    throw refuse('alreadyVoided', { details: { entityId: op.entityId } });
  }
  if (repayment.via === SALARY_REPAYMENT) {
    // An installment goes only with its payout, cancelled first in the same command.
    const payout = await db
      .selectFrom('payPayouts')
      .select(['voidedAt'])
      .where('id', '=', repayment.payoutId ?? '')
      .executeTakeFirst();
    if (payout?.voidedAt === null || payout === undefined) {
      throw refuse('repaymentNotAsPayout', {
        code: 'INVALID_TRANSITION',
        details: { entityType: PAY_REPAYMENT_ENTITY, entityId: op.entityId },
      });
    }
    return;
  }
  await requireDrawerOpen(db, op, repayment.via, Number(repayment.createdAt), PAY_REPAYMENT_ENTITY);
};

// ── payouts ──────────────────────────────────────────────────────────────────────────────────

const MONTH_SLACK_MS = 14 * 60 * 60 * 1000;

function monthIndex(month: string): number {
  const [year, number] = month.split('-').map(Number) as [number, number];
  return year * 12 + (number - 1);
}

function utcMonthIndex(ms: number): number {
  const date = new Date(ms);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

/**
 * Whether a payout may be for `month` when made at `at`: this month wherever the store is (UTC±14),
 * or one of the two before it. Never a month ahead, so nobody pays a year of salary in one go.
 */
export function payableMonth(month: string, at: number): boolean {
  if (!MONTH_PATTERN.test(month)) return false;
  const index = monthIndex(month);
  return (
    index <= utcMonthIndex(at + MONTH_SLACK_MS) && index >= utcMonthIndex(at - MONTH_SLACK_MS) - 2
  );
}

/** A person's monthly salary at the store now: their latest terms, or 0 with none. */
export async function currentSalary(db: Db, op: SignedOperation, userId: string): Promise<number> {
  const row = await db
    .selectFrom('payTerms')
    .select(['salary'])
    .where('tenantId', '=', op.tenantId)
    .where('storeId', '=', op.storeId ?? '')
    .where('userId', '=', userId)
    .orderBy('setAt', 'desc')
    .orderBy('id', 'desc')
    .executeTakeFirst();
  return row === undefined ? 0 : Number(row.salary);
}

export const paidRule: Rule = async (op, ctx) => {
  const { db } = ctx;
  const payload = payloadOf<{
    userId: string;
    month: string;
    salary: number;
    commission: number;
    deduction: number;
    repaymentId: string | null;
    paid: number;
    account: string;
  }>(op);
  await requireNew(db, 'payPayouts', op);
  requireOther(op, payload.userId);
  await requireStaff(ctx, payload.userId);
  await requirePayAccount(db, op, payload.account);
  if (!payableMonth(payload.month, op.timestamp)) {
    throw refuse('monthOutOfRange', {
      code: 'VALIDATION_FAILED',
      details: { field: 'month', issue: 'this month or one of the two before it' },
    });
  }
  const paidAlready = await db
    .selectFrom('payPayouts')
    .select('id')
    .where('tenantId', '=', op.tenantId)
    .where('storeId', '=', op.storeId ?? '')
    .where('userId', '=', payload.userId)
    .where('month', '=', payload.month)
    .where('voidedAt', 'is', null)
    .executeTakeFirst();
  if (paidAlready !== undefined) {
    throw refuse('monthPaid', {
      details: { entityType: PAY_PAYOUT_ENTITY, entityId: paidAlready.id },
    });
  }
  const salary = await currentSalary(db, op, payload.userId);
  if (payload.salary > salary) {
    throw refuse('salaryAboveTerms', {
      code: 'VALIDATION_FAILED',
      details: { field: 'salary', issue: `at most ${salary}` },
    });
  }
  const { owed } = await commissionBalance(
    db as unknown as CommissionDb,
    scopeOf(op),
    payload.userId,
    op.timestamp,
  );
  if (payload.commission > Math.max(owed, 0) || payload.commission < Math.min(owed, 0)) {
    throw refuse('commissionAboveOwed', {
      code: 'VALIDATION_FAILED',
      details: {
        field: 'commission',
        issue: `between ${Math.min(owed, 0)} and ${Math.max(owed, 0)}`,
      },
    });
  }
  const { balance } = await advanceBalance(db, scopeOf(op), payload.userId);
  if (payload.deduction > balance) {
    throw refuse('aboveBalance', {
      code: 'VALIDATION_FAILED',
      details: { field: 'deduction', issue: `at most ${balance}` },
    });
  }
  if (payload.deduction > 0 !== (payload.repaymentId !== null)) {
    throw refuse('repaymentNotAsPayout', {
      code: 'VALIDATION_FAILED',
      details: { field: 'repaymentId', issue: 'names a repayment exactly when kasbon comes off' },
    });
  }
  if (
    payload.paid !== payload.salary + payload.commission - payload.deduction ||
    payload.paid < 0
  ) {
    throw refuse('paidNotTotal', {
      code: 'VALIDATION_FAILED',
      details: { field: 'paid', issue: 'salary + commission − installment, never below zero' },
    });
  }
};

export const payoutVoidedRule: Rule = async (op, { db }) => {
  const payout = await db
    .selectFrom('payPayouts')
    .select(['account', 'createdAt', 'voidedAt'])
    .where('id', '=', op.entityId)
    .where('tenantId', '=', op.tenantId)
    .where('storeId', '=', op.storeId ?? '')
    .executeTakeFirst();
  if (payout === undefined) {
    throw refuse('payoutNotFound', {
      code: 'ENTITY_NOT_FOUND',
      details: { entityType: PAY_PAYOUT_ENTITY, entityId: op.entityId },
    });
  }
  if (payout.voidedAt !== null) {
    throw refuse('alreadyVoided', { details: { entityId: op.entityId } });
  }
  await requireDrawerOpen(db, op, payout.account, Number(payout.createdAt), PAY_PAYOUT_ENTITY);
};

// ── commission by hand ───────────────────────────────────────────────────────────────────────

export const commissionAdjustedRule: Rule = async (op, ctx) => {
  const payload = payloadOf<{ userId: string; amount: number }>(op);
  await requireNew(ctx.db, 'payAdjustments', op);
  requireOther(op, payload.userId);
  await requireStaff(ctx, payload.userId);
  if (payload.amount === 0) {
    throw refuse('zeroAdjustment', {
      code: 'VALIDATION_FAILED',
      details: { field: 'amount', issue: 'not zero' },
    });
  }
};
