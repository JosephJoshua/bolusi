// The `pay` queries. Everything is this store's, scoped to the runtime-minted tenant and store.
//
// - `payPeople`: one row per person asked for (the screen passes the store's staff): their salary,
//   rate, commission owed now and kasbon. For the owners' "Gaji" list.
// - `payPerson`: one person's statement: what earned commission since their last payout, their
//   kasbon, payouts and changes by hand. The same figures a payout takes.
// - `kasbon`: balances and history only, for whoever keeps kasbon without seeing salaries.
import { z } from 'zod';

import type { QueryContext, QueryPage } from '@bolusi/core';
import { zUuid } from '@bolusi/schemas';

import { advanceBalance } from './advances.js';
import {
  commissionBalance,
  earnedServisan,
  type CommissionDb,
  type EarnedServisan,
  type PayScope,
} from './commission.js';
import { PAY_PERMISSION } from './constants.js';
import type { PayDatabase } from './schema.js';

type Qctx = QueryContext<PayDatabase>;

function scopeOf(qctx: Qctx): PayScope {
  return { tenantId: qctx.tenantId, storeId: qctx.storeId ?? '' };
}

/** The projection, as the shared readers take it (they only select). */
function dbOf(qctx: Qctx): CommissionDb {
  return qctx.db as unknown as CommissionDb;
}

export interface PayTerms {
  readonly salary: number;
  /** Their own rate, or null for the store's. */
  readonly commissionPercent: number | null;
}

async function termsOf(qctx: Qctx, userIds: readonly string[]): Promise<Map<string, PayTerms>> {
  if (userIds.length === 0) return new Map();
  const rows = await qctx.db
    .selectFrom('payTerms')
    .select(['userId', 'salary', 'commissionPercent', 'setAt', 'id'])
    .where('tenantId', '=', qctx.tenantId)
    .where('storeId', '=', qctx.storeId ?? '')
    .where('userId', 'in', userIds)
    .orderBy('setAt')
    .orderBy('id')
    .execute();
  const out = new Map<string, PayTerms>();
  for (const row of rows) {
    out.set(row.userId, {
      salary: Number(row.salary),
      commissionPercent: row.commissionPercent === null ? null : Number(row.commissionPercent),
    });
  }
  return out;
}

/** The store's commission rate now, or null while it is off. */
export async function storeCommission(qctx: Qctx): Promise<number | null> {
  const row = await qctx.db
    .selectFrom('payStoreRates')
    .select(['commissionPercent'])
    .where('tenantId', '=', qctx.tenantId)
    .where('storeId', '=', qctx.storeId ?? '')
    .orderBy('setAt', 'desc')
    .orderBy('id', 'desc')
    .executeTakeFirst();
  return row?.commissionPercent === null || row === undefined
    ? null
    : Number(row.commissionPercent);
}

// ── payPeople ──────────────────────────────────────────────────────────────────────────────────

/** `at`: the moment the figures are for (the screen's clock): handlers have none of their own. */
export const payPeopleInput = z
  .object({ userIds: z.array(zUuid).max(500), at: z.number().int() })
  .strict();

export interface PayPersonRow {
  readonly userId: string;
  /** Null before an owner set their terms. */
  readonly terms: PayTerms | null;
  /** The rate their commission is counted at now; null while the store's commission is off. */
  readonly percent: number | null;
  readonly commissionOwed: number;
  /** Servisan waiting for a part price before they count. */
  readonly commissionPending: number;
  /** Absent for a reader who does not keep kasbon. */
  readonly kasbon?: { readonly balance: number; readonly installment: number };
  /** Their payout for the month `at` falls in, if any; `month` is that month. */
  readonly paidThisMonth: boolean;
}

export interface PayPeople {
  readonly storeCommission: number | null;
  readonly month: string;
  readonly people: readonly PayPersonRow[];
}

/** `2026-11`, in the device's own time: the month the store is in. */
export function monthOf(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

async function payPeopleHandler(
  input: z.output<typeof payPeopleInput>,
  qctx: Qctx,
): Promise<QueryPage<PayPeople>> {
  const { at } = input;
  const month = monthOf(at);
  const percent = await storeCommission(qctx);
  const terms = await termsOf(qctx, input.userIds);
  const earned = await earnedServisan(dbOf(qctx), scopeOf(qctx), { until: at, technicianId: null });
  const seesKasbon = qctx.hasPermission(PAY_PERMISSION.advances);
  const paid = new Set(
    input.userIds.length === 0
      ? []
      : (
          await qctx.db
            .selectFrom('payPayouts')
            .select(['userId'])
            .where('tenantId', '=', qctx.tenantId)
            .where('storeId', '=', qctx.storeId ?? '')
            .where('month', '=', month)
            .where('voidedAt', 'is', null)
            .where('userId', 'in', input.userIds)
            .execute()
        ).map((row) => row.userId),
  );
  const people: PayPersonRow[] = [];
  for (const userId of input.userIds) {
    const own = terms.get(userId) ?? null;
    const balance = await commissionBalance(dbOf(qctx), scopeOf(qctx), userId, at, earned);
    people.push({
      userId,
      terms: own,
      percent: percent === null ? null : (own?.commissionPercent ?? percent),
      commissionOwed: balance.owed,
      commissionPending: balance.pending,
      ...(seesKasbon ? { kasbon: await advanceBalance(qctx.db, scopeOf(qctx), userId) } : {}),
      paidThisMonth: paid.has(userId),
    });
  }
  return { rows: [{ storeCommission: percent, month, people }], nextCursor: null };
}

export const payPeopleQuery = {
  name: 'payPeople',
  permission: PAY_PERMISSION.read,
  input: payPeopleInput,
  handler: payPeopleHandler,
} as const;

// ── payPerson ──────────────────────────────────────────────────────────────────────────────────

export const payPersonInput = z.object({ userId: zUuid, at: z.number().int() }).strict();

export interface PayoutRow {
  readonly id: string;
  readonly month: string;
  readonly salary: number;
  readonly commission: number;
  readonly deduction: number;
  readonly paid: number;
  readonly account: string;
  readonly note: string | null;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly voidedAt: number | null;
  readonly voidReason: string | null;
}

export interface AdjustmentRow {
  readonly id: string;
  readonly amount: number;
  readonly reason: string;
  readonly createdBy: string;
  readonly createdAt: number;
}

export interface PayStatement {
  readonly userId: string;
  readonly terms: PayTerms | null;
  readonly percent: number | null;
  readonly commission: {
    readonly earned: number;
    readonly adjusted: number;
    readonly paid: number;
    readonly owed: number;
    readonly pending: number;
  };
  /** Servisan earned since their last payout, and every one still waiting for a part price. */
  readonly servisan: readonly EarnedServisan[];
  readonly adjustments: readonly AdjustmentRow[];
  readonly payouts: readonly PayoutRow[];
  /** Absent for a reader who does not keep kasbon. */
  readonly kasbon?: KasbonStatement;
  /** The month `at` falls in, and whether it is paid. */
  readonly month: string;
  readonly paidThisMonth: boolean;
}

async function payPersonHandler(
  input: z.output<typeof payPersonInput>,
  qctx: Qctx,
): Promise<QueryPage<PayStatement>> {
  const { at } = input;
  const month = monthOf(at);
  const scope = scopeOf(qctx);
  const percent = await storeCommission(qctx);
  const terms = (await termsOf(qctx, [input.userId])).get(input.userId) ?? null;
  const earned = await earnedServisan(dbOf(qctx), scope, { until: at, technicianId: input.userId });
  const commission = await commissionBalance(dbOf(qctx), scope, input.userId, at, earned);
  const payouts = (
    await qctx.db
      .selectFrom('payPayouts')
      .selectAll()
      .where('tenantId', '=', qctx.tenantId)
      .where('storeId', '=', qctx.storeId ?? '')
      .where('userId', '=', input.userId)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .execute()
  ).map((row): PayoutRow => ({
    id: row.id,
    month: row.month,
    salary: Number(row.salary),
    commission: Number(row.commission),
    deduction: Number(row.deduction),
    paid: Number(row.paid),
    account: row.account,
    note: row.note,
    createdBy: row.createdBy,
    createdAt: Number(row.createdAt),
    voidedAt: row.voidedAt === null ? null : Number(row.voidedAt),
    voidReason: row.voidReason,
  }));
  const lastPaidAt = payouts.find((row) => row.voidedAt === null)?.createdAt ?? 0;
  const adjustments = (
    await qctx.db
      .selectFrom('payAdjustments')
      .selectAll()
      .where('tenantId', '=', qctx.tenantId)
      .where('storeId', '=', qctx.storeId ?? '')
      .where('userId', '=', input.userId)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .execute()
  ).map((row): AdjustmentRow => ({
    id: row.id,
    amount: Number(row.amount),
    reason: row.reason,
    createdBy: row.createdBy,
    createdAt: Number(row.createdAt),
  }));
  const statement: PayStatement = {
    userId: input.userId,
    terms,
    percent: percent === null ? null : (terms?.commissionPercent ?? percent),
    commission,
    servisan: earned
      .filter((row) => row.earnedAt > lastPaidAt || row.commission === null)
      .reverse(),
    adjustments,
    payouts,
    ...(qctx.hasPermission(PAY_PERMISSION.advances)
      ? { kasbon: await kasbonOf(qctx, input.userId) }
      : {}),
    month,
    paidThisMonth: payouts.some((row) => row.month === month && row.voidedAt === null),
  };
  return { rows: [statement], nextCursor: null };
}

export const payPersonQuery = {
  name: 'payPerson',
  permission: PAY_PERMISSION.read,
  input: payPersonInput,
  handler: payPersonHandler,
} as const;

// ── kasbon ─────────────────────────────────────────────────────────────────────────────────────

export interface AdvanceRow {
  readonly id: string;
  readonly amount: number;
  readonly account: string;
  readonly reason: string;
  readonly installment: number;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly voidedAt: number | null;
  readonly voidReason: string | null;
}

export interface RepaymentRow {
  readonly id: string;
  readonly amount: number;
  /** A payment account, `salary` or `written_off`. */
  readonly via: string;
  readonly payoutId: string | null;
  readonly note: string | null;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly voidedAt: number | null;
  readonly voidReason: string | null;
}

export interface KasbonStatement {
  readonly balance: number;
  readonly installment: number;
  readonly advances: readonly AdvanceRow[];
  readonly repayments: readonly RepaymentRow[];
}

async function kasbonOf(qctx: Qctx, userId: string): Promise<KasbonStatement> {
  const scope = scopeOf(qctx);
  const { balance, installment } = await advanceBalance(qctx.db, scope, userId);
  const advances = (
    await qctx.db
      .selectFrom('payAdvances')
      .selectAll()
      .where('tenantId', '=', scope.tenantId)
      .where('storeId', '=', scope.storeId)
      .where('userId', '=', userId)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .execute()
  ).map((row): AdvanceRow => ({
    id: row.id,
    amount: Number(row.amount),
    account: row.account,
    reason: row.reason,
    installment: Number(row.installment),
    createdBy: row.createdBy,
    createdAt: Number(row.createdAt),
    voidedAt: row.voidedAt === null ? null : Number(row.voidedAt),
    voidReason: row.voidReason,
  }));
  const repayments = (
    await qctx.db
      .selectFrom('payRepayments')
      .selectAll()
      .where('tenantId', '=', scope.tenantId)
      .where('storeId', '=', scope.storeId)
      .where('userId', '=', userId)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .execute()
  ).map((row): RepaymentRow => ({
    id: row.id,
    amount: Number(row.amount),
    via: row.via,
    payoutId: row.payoutId,
    note: row.note,
    createdBy: row.createdBy,
    createdAt: Number(row.createdAt),
    voidedAt: row.voidedAt === null ? null : Number(row.voidedAt),
    voidReason: row.voidReason,
  }));
  return { balance, installment, advances, repayments };
}

export const kasbonInput = z.object({ userId: zUuid }).strict();

async function kasbonHandler(
  input: z.output<typeof kasbonInput>,
  qctx: Qctx,
): Promise<QueryPage<KasbonStatement>> {
  return { rows: [await kasbonOf(qctx, input.userId)], nextCursor: null };
}

export const kasbonQuery = {
  name: 'kasbon',
  permission: PAY_PERMISSION.advances,
  input: kasbonInput,
  handler: kasbonHandler,
} as const;

export const kasbonBalancesInput = z.object({ userIds: z.array(zUuid).max(500) }).strict();

export interface KasbonBalanceRow {
  readonly userId: string;
  readonly balance: number;
  readonly installment: number;
}

async function kasbonBalancesHandler(
  input: z.output<typeof kasbonBalancesInput>,
  qctx: Qctx,
): Promise<QueryPage<KasbonBalanceRow>> {
  const rows: KasbonBalanceRow[] = [];
  for (const userId of input.userIds) {
    rows.push({ userId, ...(await advanceBalance(qctx.db, scopeOf(qctx), userId)) });
  }
  return { rows, nextCursor: null };
}

export const kasbonBalancesQuery = {
  name: 'kasbonBalances',
  permission: PAY_PERMISSION.advances,
  input: kasbonBalancesInput,
  handler: kasbonBalancesHandler,
} as const;
