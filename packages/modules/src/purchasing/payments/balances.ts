// What each bill still owes and what a supplier holds as credit, read from the store's standing
// bills and payments. Nothing is stored: a payment recorded offline, a bill corrected or voided
// later, changes the figures on the next read, and the same records always give the same figures.
//
// A payment goes first to the bill it names, as far as that bill still owes. Whatever is left, a
// payment made ahead (no bill), more than its bill came to, or one whose bill was voided, is the
// supplier's credit, and pays their bills in the order they fall due (the earliest due date, then
// the earliest nota). What remains after every bill is paid is credit still held.
import type { QueryContext } from '@bolusi/core';

import type { PurchasingDatabase } from '../schema.js';

type Qctx = QueryContext<PurchasingDatabase>;

export interface BillToPay {
  readonly id: string;
  readonly supplierId: string;
  readonly total: number;
  readonly billedOn: number;
  readonly dueOn: number | null;
  readonly billNumber: string;
}

export interface PaymentPart {
  readonly supplierId: string;
  readonly billId: string | null;
  readonly amount: number;
}

export interface Balances {
  /** By bill: what its own payments and the supplier's credit have paid of it, at most its total. */
  readonly paid: ReadonlyMap<string, number>;
  /** By bill: what of `paid` came from the supplier's credit rather than its own payments. */
  readonly fromCredit: ReadonlyMap<string, number>;
  /** By supplier: credit left once every bill is paid. */
  readonly credit: ReadonlyMap<string, number>;
}

/** When a bill falls due, for the order credit pays bills in. */
function dueOrder(a: BillToPay, b: BillToPay): number {
  return (
    (a.dueOn ?? a.billedOn) - (b.dueOn ?? b.billedOn) ||
    a.billedOn - b.billedOn ||
    a.billNumber.localeCompare(b.billNumber) ||
    a.id.localeCompare(b.id)
  );
}

/** The standing bills and payments of a store, allocated as the header says. */
export function allocate(bills: readonly BillToPay[], payments: readonly PaymentPart[]): Balances {
  const owed = new Map(bills.map((bill) => [bill.id, bill.total]));
  const supplierOf = new Map(bills.map((bill) => [bill.id, bill.supplierId]));
  const paid = new Map<string, number>();
  const fromCredit = new Map<string, number>();
  const pool = new Map<string, number>();
  const addTo = (map: Map<string, number>, key: string, amount: number) =>
    map.set(key, (map.get(key) ?? 0) + amount);

  for (const payment of payments) {
    const left =
      payment.billId !== null && supplierOf.get(payment.billId) === payment.supplierId
        ? (owed.get(payment.billId) ?? 0)
        : 0;
    const applied = Math.min(left, payment.amount);
    if (applied > 0 && payment.billId !== null) {
      owed.set(payment.billId, left - applied);
      addTo(paid, payment.billId, applied);
    }
    if (payment.amount > applied) addTo(pool, payment.supplierId, payment.amount - applied);
  }

  for (const bill of [...bills].sort(dueOrder)) {
    const credit = pool.get(bill.supplierId) ?? 0;
    const applied = Math.min(credit, owed.get(bill.id) ?? 0);
    if (applied <= 0) continue;
    pool.set(bill.supplierId, credit - applied);
    owed.set(bill.id, (owed.get(bill.id) ?? 0) - applied);
    addTo(paid, bill.id, applied);
    addTo(fromCredit, bill.id, applied);
  }

  for (const [supplierId, credit] of pool) if (credit === 0) pool.delete(supplierId);
  return { paid, fromCredit, credit: pool };
}

/**
 * The store's balances, for every supplier or only `supplierIds`. Reads every standing bill of
 * those suppliers, since credit pays any of them; each bill is one row with its total.
 */
export async function storeBalances(
  qctx: Qctx,
  supplierIds: readonly string[] | null = null,
): Promise<Balances & { readonly bills: readonly BillToPay[] }> {
  if (supplierIds !== null && supplierIds.length === 0) {
    return { paid: new Map(), fromCredit: new Map(), credit: new Map(), bills: [] };
  }
  let billQuery = qctx.db
    .selectFrom('purchasingBills as b')
    .leftJoin('purchasingBillLines as l', 'l.billId', 'b.id')
    .select((eb) => [
      'b.id',
      'b.supplierId',
      'b.billNumber',
      'b.billedOn',
      'b.dueOn',
      'b.charges',
      eb.fn
        .coalesce(eb.fn.sum<number | string>(eb('l.qty', '*', eb.ref('l.unitPrice'))), eb.lit(0))
        .as('parts'),
    ])
    .where('b.tenantId', '=', qctx.tenantId)
    .where('b.storeId', '=', qctx.storeId)
    .where('b.status', '=', 'open')
    .groupBy(['b.id', 'b.supplierId', 'b.billNumber', 'b.billedOn', 'b.dueOn', 'b.charges']);
  let paymentQuery = qctx.db
    .selectFrom('purchasingPayments')
    .select((eb) => ['supplierId', 'billId', eb.fn.sum<number | string>('amount').as('amount')])
    .where('tenantId', '=', qctx.tenantId)
    .where('storeId', '=', qctx.storeId)
    .where('voidedAt', 'is', null)
    .groupBy(['supplierId', 'billId']);
  if (supplierIds !== null) {
    billQuery = billQuery.where('b.supplierId', 'in', supplierIds);
    paymentQuery = paymentQuery.where('supplierId', 'in', supplierIds);
  }
  const [billRows, paymentRows] = await Promise.all([billQuery.execute(), paymentQuery.execute()]);
  const bills = billRows.map((row) => ({
    id: row.id,
    supplierId: row.supplierId,
    billNumber: row.billNumber,
    billedOn: Number(row.billedOn),
    dueOn: row.dueOn === null ? null : Number(row.dueOn),
    total: Number(row.charges) + Number(row.parts),
  }));
  const payments = paymentRows.map((row) => ({
    supplierId: row.supplierId,
    billId: row.billId,
    amount: Number(row.amount),
  }));
  return { ...allocate(bills, payments), bills };
}
