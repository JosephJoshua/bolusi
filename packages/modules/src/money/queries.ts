// The `money` queries. Every read is constrained to the caller's store; central accounts are read
// only when this store uses them. Postgres hands `bigint` columns back as strings, hence `Number`.
import { sql } from 'kysely';
import { z } from 'zod';

import type { QueryContext, QueryPage } from '@bolusi/core';
import { zMsEpoch, zUuid } from '@bolusi/schemas';

import {
  CASH_ACCOUNT,
  MONEY_PERMISSION,
  SYSTEM_ACCOUNT,
  type CashMoveKind,
  type EntryKind,
  type PaymentAccountKind,
} from './constants.js';
import { documentBalance, documentTotal } from './rules.js';
import type { MoneyDatabase } from './schema.js';

type Qctx = QueryContext<MoneyDatabase>;

function storeOf(qctx: Qctx): string {
  return qctx.storeId ?? '';
}

// ── paymentAccounts (what the counter can take money through) ─────────────────────────────────

export interface PaymentAccountRow {
  readonly id: string;
  readonly kind: PaymentAccountKind;
  readonly name: string;
  readonly active: boolean;
  /** True for an account shared by the franchise's stores. */
  readonly central: boolean;
  /** Central accounts: the stores that use it, empty for every store. */
  readonly storeIds: readonly string[];
}

export const paymentAccountsInput = z
  .object({
    /** Settings list inactive accounts too, and every central one; the payment step does not. */
    includeInactive: z.boolean().default(false),
  })
  .strict();

async function paymentAccountsHandler(
  input: z.output<typeof paymentAccountsInput>,
  qctx: Qctx,
): Promise<QueryPage<PaymentAccountRow>> {
  const store = storeOf(qctx);
  let query = qctx.db
    .selectFrom('moneyAccounts')
    .selectAll()
    .where('tenantId', '=', qctx.tenantId)
    .where((eb) => eb.or([eb('storeId', '=', store), eb('storeId', 'is', null)]));
  if (!input.includeInactive) query = query.where('active', '=', 1);
  const rows = await query.orderBy('name').orderBy('id').execute();
  const accounts = rows
    .map((row) => ({
      id: row.id,
      kind: row.kind as PaymentAccountKind,
      name: row.name,
      active: Number(row.active) === 1,
      central: row.storeId === null,
      storeIds: row.storeId === null ? (JSON.parse(row.storeIdsJson ?? '[]') as string[]) : [],
    }))
    .filter(
      (account) =>
        !account.central ||
        input.includeInactive ||
        account.storeIds.length === 0 ||
        account.storeIds.includes(store),
    );
  return { rows: accounts, nextCursor: null };
}

export const paymentAccountsQuery = {
  name: 'paymentAccounts',
  permission: MONEY_PERMISSION.receive,
  input: paymentAccountsInput,
  handler: paymentAccountsHandler,
} as const;

// ── documentMoney (one document's charges, payments and refunds) ───────────────────────────────

export interface MoneyEntryRow {
  readonly id: string;
  readonly kind: EntryKind;
  readonly account: string | null;
  readonly amount: number;
  readonly subKind: CashMoveKind | null;
  readonly reference: string | null;
  readonly reason: string | null;
  readonly tendered: number | null;
  readonly documentKind: string | null;
  readonly documentId: string | null;
  readonly documentLabel: string | null;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly voidedBy: string | null;
  readonly voidedAt: number | null;
  readonly voidReason: string | null;
}

export interface DocumentMoney {
  /** What the customer owes now: positive owed, negative paid ahead, zero settled. */
  readonly balance: number;
  /** Everything charged, before any owner reduction. */
  readonly charged: number;
  readonly reduced: number;
  /** Payments that still count, less refunds. */
  readonly paid: number;
  readonly entries: readonly MoneyEntryRow[];
}

function entryRow(row: Record<string, unknown>): MoneyEntryRow {
  const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
  return {
    id: row['id'] as string,
    kind: row['kind'] as EntryKind,
    account: (row['account'] as string | null) ?? null,
    amount: Number(row['amount']),
    subKind: (row['subKind'] as CashMoveKind | null) ?? null,
    reference: (row['reference'] as string | null) ?? null,
    reason: (row['reason'] as string | null) ?? null,
    tendered: num(row['tendered']),
    documentKind: (row['documentKind'] as string | null) ?? null,
    documentId: (row['documentId'] as string | null) ?? null,
    documentLabel: (row['documentLabel'] as string | null) ?? null,
    createdBy: row['createdBy'] as string,
    createdAt: Number(row['createdAt']),
    voidedBy: (row['voidedBy'] as string | null) ?? null,
    voidedAt: num(row['voidedAt']),
    voidReason: (row['voidReason'] as string | null) ?? null,
  };
}

export const documentMoneyInput = z.object({ kind: z.string().min(1).max(40), id: zUuid }).strict();

async function documentMoneyHandler(
  input: z.output<typeof documentMoneyInput>,
  qctx: Qctx,
): Promise<QueryPage<DocumentMoney>> {
  const store = storeOf(qctx);
  const rows = await qctx.db
    .selectFrom('moneyEntries')
    .selectAll()
    .where('storeId', '=', store)
    .where('documentKind', '=', input.kind)
    .where('documentId', '=', input.id)
    .orderBy('createdAt')
    .orderBy('id')
    .execute();
  const entries = rows.map((row) => entryRow(row as unknown as Record<string, unknown>));
  const charged = await documentTotal(qctx.db, store, input, 'charge_recorded');
  const reduced = await documentTotal(qctx.db, store, input, 'charge_reduced');
  const balance = await documentBalance(qctx.db, store, input);
  return {
    rows: [{ balance, charged, reduced, paid: charged - reduced - balance, entries }],
    nextCursor: null,
  };
}

export const documentMoneyQuery = {
  name: 'documentMoney',
  permission: MONEY_PERMISSION.receive,
  input: documentMoneyInput,
  handler: documentMoneyHandler,
} as const;

// ── cashDrawer (what should be in the drawer, and the counts) ──────────────────────────────────

export interface CashCountRow {
  readonly id: string;
  readonly counted: number;
  /** The book's cash just before the count, as this device knows it now. */
  readonly expected: number;
  readonly difference: number;
  readonly note: string | null;
  readonly countedBy: string;
  readonly countedAt: number;
  /** The owner's adjustments that settled it. */
  readonly settled: number;
}

export interface CashDrawer {
  /** What the book says is in the drawer now. */
  readonly expected: number;
  /** The latest counts, newest first. */
  readonly counts: readonly CashCountRow[];
}

async function cashBalanceBefore(qctx: Qctx, at: number | null): Promise<number> {
  let query = qctx.db
    .selectFrom('moneyLines')
    .select(sql<string | number>`COALESCE(SUM(debit - credit), 0)`.as('balance'))
    .where('storeId', '=', storeOf(qctx))
    .where('account', '=', CASH_ACCOUNT);
  if (at !== null) query = query.where('at', '<', at);
  const row = await query.executeTakeFirst();
  return Number(row?.balance ?? 0);
}

export const cashDrawerInput = z
  .object({ counts: z.number().int().min(0).max(100).default(10) })
  .strict();

async function cashDrawerHandler(
  input: z.output<typeof cashDrawerInput>,
  qctx: Qctx,
): Promise<QueryPage<CashDrawer>> {
  const store = storeOf(qctx);
  const counts =
    input.counts === 0
      ? []
      : await qctx.db
          .selectFrom('moneyEntries')
          .selectAll()
          .where('storeId', '=', store)
          .where('kind', '=', 'cash_counted')
          .orderBy('createdAt', 'desc')
          .orderBy('id', 'desc')
          .limit(input.counts)
          .execute();
  const adjustments = await qctx.db
    .selectFrom('moneyEntries')
    .select(['amount', 'relatedEntryId'])
    .where('storeId', '=', store)
    .where('kind', '=', 'cash_adjusted')
    .execute();
  const rows: CashCountRow[] = [];
  for (const count of counts) {
    const counted = Number(count.amount);
    const expected = await cashBalanceBefore(qctx, Number(count.createdAt));
    const settled = adjustments
      .filter((adjustment) => adjustment.relatedEntryId === count.id)
      .reduce((sum, adjustment) => sum + Number(adjustment.amount), 0);
    rows.push({
      id: count.id,
      counted,
      expected,
      difference: counted - expected,
      note: count.reason,
      countedBy: count.createdBy,
      countedAt: Number(count.createdAt),
      settled,
    });
  }
  return {
    rows: [{ expected: await cashBalanceBefore(qctx, null), counts: rows }],
    nextCursor: null,
  };
}

export const cashDrawerQuery = {
  name: 'cashDrawer',
  permission: MONEY_PERMISSION.countCash,
  input: cashDrawerInput,
  handler: cashDrawerHandler,
} as const;

// ── moneyEntries (the store's records over a period) ───────────────────────────────────────────

export const moneyEntriesInput = z
  .object({
    from: zMsEpoch,
    to: zMsEpoch,
    limit: z.number().int().min(1).max(500).default(200),
  })
  .strict();

async function moneyEntriesHandler(
  input: z.output<typeof moneyEntriesInput>,
  qctx: Qctx,
): Promise<QueryPage<MoneyEntryRow>> {
  const rows = await qctx.db
    .selectFrom('moneyEntries')
    .selectAll()
    .where('storeId', '=', storeOf(qctx))
    .where('createdAt', '>=', input.from)
    .where('createdAt', '<', input.to)
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc')
    .limit(input.limit)
    .execute();
  return {
    rows: rows.map((row) => entryRow(row as unknown as Record<string, unknown>)),
    nextCursor: null,
  };
}

export const moneyEntriesQuery = {
  name: 'moneyEntries',
  permission: MONEY_PERMISSION.read,
  input: moneyEntriesInput,
  handler: moneyEntriesHandler,
} as const;

// ── openBalances (documents a customer still owes on: "Belum lunas") ───────────────────────────

export interface OpenBalanceRow {
  readonly documentKind: string;
  readonly documentId: string;
  readonly documentLabel: string;
  readonly balance: number;
  /** When the charge was recorded (the phone went home unpaid). */
  readonly since: number;
}

export const openBalancesInput = z.object({}).strict();

async function openBalancesHandler(
  _input: z.output<typeof openBalancesInput>,
  qctx: Qctx,
): Promise<QueryPage<OpenBalanceRow>> {
  const store = storeOf(qctx);
  // Only charged documents: a DP on an unfinished repair is money paid ahead, not a debt.
  const rows = await qctx.db
    .selectFrom('moneyLines as l')
    .innerJoin('moneyEntries as e', 'e.id', 'l.entryId')
    .select([
      'l.documentKind',
      'l.documentId',
      sql<string>`MAX(e.document_label)`.as('documentLabel'),
      sql<string | number>`SUM(l.debit - l.credit)`.as('balance'),
      sql<string | number>`MIN(CASE WHEN e.kind = 'charge_recorded' THEN e.created_at END)`.as(
        'since',
      ),
    ])
    .where('l.storeId', '=', store)
    .where('l.account', '=', SYSTEM_ACCOUNT.receivable)
    .groupBy(['l.documentKind', 'l.documentId'])
    .having(sql<boolean>`SUM(l.debit - l.credit) > 0`)
    .having(
      sql<boolean>`MIN(CASE WHEN e.kind = 'charge_recorded' THEN e.created_at END) IS NOT NULL`,
    )
    .execute();
  return {
    rows: rows
      .map((row) => ({
        documentKind: row.documentKind ?? '',
        documentId: row.documentId ?? '',
        documentLabel: row.documentLabel,
        balance: Number(row.balance),
        since: Number(row.since),
      }))
      .sort((a, b) => a.since - b.since || a.documentId.localeCompare(b.documentId)),
    nextCursor: null,
  };
}

export const openBalancesQuery = {
  name: 'openBalances',
  permission: MONEY_PERMISSION.read,
  input: openBalancesInput,
  handler: openBalancesHandler,
} as const;
