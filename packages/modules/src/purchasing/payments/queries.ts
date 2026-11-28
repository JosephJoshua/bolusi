// The supplier payment queries: a bill's payments, one payment, a supplier's credit and where a
// payment may come from. Read only with "Tagihan supplier" (the pay sources with "Bayar supplier").
import { z } from 'zod';

import type { QueryContext, QueryPage } from '@bolusi/core';

import { CASH_ACCOUNT, MONEY_PERMISSION, paymentAccountIdOf } from '../../money/constants.js';
import { paymentAccountsHandler } from '../../money/queries.js';
import type { MoneyDatabase } from '../../money/schema.js';
import { userNames } from '../../shared/user-names.js';
import { OWNER_FUNDS, PURCHASING_PERMISSION } from '../constants.js';
import type { PurchasingDatabase } from '../schema.js';
import { storeBalances } from './balances.js';

type Qctx = QueryContext<PurchasingDatabase>;

/** Where a payment came from, as the screens name it. */
export type PaymentSourceKind = 'cash' | 'bank' | 'owner';

export interface PaymentRow {
  readonly id: string;
  readonly supplierId: string;
  readonly billId: string | null;
  readonly amount: number;
  readonly source: string;
  readonly sourceKind: PaymentSourceKind;
  /** The bank account's name; null for the drawer, the owner's money or an account not known here. */
  readonly accountName: string | null;
  readonly reference: string | null;
  readonly note: string | null;
  readonly createdBy: string;
  readonly createdByName: string | null;
  readonly createdAt: number;
  readonly voidedAt: number | null;
  readonly voidedByName: string | null;
  readonly voidReason: string | null;
}

export function sourceKindOf(source: string): PaymentSourceKind {
  if (source === CASH_ACCOUNT) return 'cash';
  return source === OWNER_FUNDS ? 'owner' : 'bank';
}

/** The names of the store's bank accounts, where this person may read them. */
async function accountNames(qctx: Qctx, sources: readonly string[]): Promise<Map<string, string>> {
  const ids = [
    ...new Set(sources.map(paymentAccountIdOf).filter((id): id is string => id !== null)),
  ];
  if (ids.length === 0 || !qctx.hasPermission(MONEY_PERMISSION.read)) return new Map();
  const rows = await (qctx.db as unknown as Qctx['db'] & QueryContext<MoneyDatabase>['db'])
    .selectFrom('moneyAccounts')
    .select(['id', 'name'])
    .where('tenantId', '=', qctx.tenantId)
    .where('id', 'in', ids)
    .execute();
  return new Map(rows.map((row) => [`account:${row.id}`, row.name]));
}

/** A store's payments, oldest first, as the screens read them. */
export async function paymentRows(
  qctx: Qctx,
  where: { readonly billId?: string; readonly paymentId?: string },
): Promise<PaymentRow[]> {
  let query = qctx.db
    .selectFrom('purchasingPayments')
    .selectAll()
    .where('tenantId', '=', qctx.tenantId)
    .where('storeId', '=', qctx.storeId);
  if (where.billId !== undefined) query = query.where('billId', '=', where.billId);
  if (where.paymentId !== undefined) query = query.where('id', '=', where.paymentId);
  const rows = await query.orderBy('createdAt').orderBy('id').execute();
  const [names, accounts] = await Promise.all([
    userNames(
      qctx.db,
      rows.flatMap((row) => [row.createdBy, row.voidedBy]),
    ),
    accountNames(
      qctx,
      rows.map((row) => row.source),
    ),
  ]);
  return rows.map((row) => ({
    id: row.id,
    supplierId: row.supplierId,
    billId: row.billId,
    amount: Number(row.amount),
    source: row.source,
    sourceKind: sourceKindOf(row.source),
    accountName: accounts.get(row.source) ?? null,
    reference: row.reference,
    note: row.note,
    createdBy: row.createdBy,
    createdByName: names.get(row.createdBy) ?? null,
    createdAt: Number(row.createdAt),
    voidedAt: row.voidedAt === null ? null : Number(row.voidedAt),
    voidedByName: row.voidedBy === null ? null : (names.get(row.voidedBy) ?? null),
    voidReason: row.voidReason,
  }));
}

// ── supplierPayment ────────────────────────────────────────────────────────────────────────────

export const supplierPaymentInput = z.object({ paymentId: z.string().min(1) }).strict();

export const supplierPaymentQuery = {
  name: 'supplierPayment',
  permission: PURCHASING_PERMISSION.bills,
  input: supplierPaymentInput,
  handler: async (
    input: z.output<typeof supplierPaymentInput>,
    qctx: Qctx,
  ): Promise<QueryPage<PaymentRow>> => ({
    rows: await paymentRows(qctx, { paymentId: input.paymentId }),
    nextCursor: null,
  }),
} as const;

// ── supplierCredit ─────────────────────────────────────────────────────────────────────────────

export const supplierCreditInput = z.object({ supplierId: z.string().min(1) }).strict();

/** What the store has paid a supplier beyond their bills: it pays the next bill that falls due. */
export const supplierCreditQuery = {
  name: 'supplierCredit',
  permission: PURCHASING_PERMISSION.bills,
  input: supplierCreditInput,
  handler: async (
    input: z.output<typeof supplierCreditInput>,
    qctx: Qctx,
  ): Promise<QueryPage<{ readonly credit: number; readonly owed: number }>> => {
    const { credit, paid, bills } = await storeBalances(qctx, [input.supplierId]);
    const owed = bills.reduce((sum, bill) => sum + bill.total - (paid.get(bill.id) ?? 0), 0);
    return { rows: [{ credit: credit.get(input.supplierId) ?? 0, owed }], nextCursor: null };
  },
} as const;

// ── paymentSources ─────────────────────────────────────────────────────────────────────────────

export interface PaymentSourceRow {
  readonly source: string;
  readonly kind: PaymentSourceKind;
  /** The bank account's name, for `bank`. */
  readonly name: string | null;
}

/**
 * Where this store may pay a supplier from: the drawer, each of its active bank (transfer)
 * accounts, and the owner's own money. The accounts are money's; whoever may not read money sees
 * only the drawer and their own money.
 */
export const paymentSourcesQuery = {
  name: 'paymentSources',
  permission: PURCHASING_PERMISSION.paySuppliers,
  input: z.object({}).strict(),
  handler: async (
    _input: Record<string, never>,
    qctx: Qctx,
  ): Promise<QueryPage<PaymentSourceRow>> => {
    const banks = qctx.hasPermission(MONEY_PERMISSION.read)
      ? (
          await paymentAccountsHandler(
            { includeInactive: false, everyStore: false },
            qctx as unknown as QueryContext<MoneyDatabase>,
          )
        ).rows.filter((account) => account.kind === 'transfer')
      : [];
    return {
      rows: [
        { source: CASH_ACCOUNT, kind: 'cash', name: null },
        ...banks.map((account) => ({
          source: `account:${account.id}`,
          kind: 'bank' as const,
          name: account.name,
        })),
        { source: OWNER_FUNDS, kind: 'owner', name: null },
      ],
      nextCursor: null,
    };
  },
} as const;
