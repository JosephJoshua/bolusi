// Paying a supplier, shared by the phone's pay step and the PC's pay dialog: what is typed, what
// is still missing, and how a bill's payments read. The command checks it all again.
import { formatDate, formatMoney, keepNumbersWhole } from '@bolusi/i18n';

import { groupedRupiah, parseRupiah } from '../../shared/rupiah.js';
import { MAX_PAYMENT } from '../constants.js';
import { tp, type PurchasingKey } from '../i18n.js';
import { billOverdue, type BillListFilter, type BillRow } from '../bills/queries.js';
import type { PaymentRow, PaymentSourceRow } from './queries.js';

/** The Tagihan list's views, in the order they are offered: what is owed first. */
export const BILL_LIST_FILTERS: readonly BillListFilter[] = ['unpaid', 'overdue', 'all'];

export const BILL_FILTER_LABEL: Readonly<Record<BillListFilter, PurchasingKey>> = {
  unpaid: 'purchasing.bill.filter.unpaid',
  overdue: 'purchasing.bill.filter.overdue',
  all: 'purchasing.bill.filter.all',
};

export const BILL_FILTER_EMPTY: Readonly<Record<BillListFilter, PurchasingKey>> = {
  unpaid: 'purchasing.bill.listEmptyUnpaid',
  overdue: 'purchasing.bill.listEmptyOverdue',
  all: 'purchasing.bill.listEmpty',
};

/**
 * How much of a standing bill is owed, as its row reads: "Lunas", or "Sisa Rp 400.000" with when
 * it falls due, which turns into a warning once that day has passed.
 */
export function billStanding(
  bill: Pick<BillRow, 'balance' | 'dueOn' | 'status'>,
  today: number,
): { readonly settled: boolean; readonly owed: string | null; readonly late: string | null } {
  if (bill.status === 'void' || bill.balance === 0) {
    return { settled: bill.status === 'open', owed: null, late: null };
  }
  return {
    settled: false,
    owed: tp('purchasing.bill.balanceDue', { amount: formatMoney(bill.balance) }),
    late:
      billOverdue(bill, today) && bill.dueOn !== null
        ? tp('purchasing.bill.overdue', { date: formatDate(bill.dueOn) })
        : null,
  };
}

/** Where a payment came from, as a person reads it: "Laci kas", the bank's name, the owner. */
export function sourceLabel(source: Pick<PaymentSourceRow, 'kind' | 'name'>): string {
  if (source.kind === 'cash') return tp('purchasing.pay.cash');
  if (source.kind === 'owner') return tp('purchasing.pay.owner');
  return source.name ?? tp('purchasing.pay.source');
}

/** "28/11/2026 · BCA Toko · TRF 0912": when a payment was made and from where, for the screen. */
export function paymentLine(payment: PaymentRow): string {
  const source = sourceLabel({ kind: payment.sourceKind, name: payment.accountName });
  return [
    tp('purchasing.pay.line', { date: formatDate(payment.createdAt), source }),
    payment.reference === null ? null : keepNumbersWhole(payment.reference),
  ]
    .filter((part) => part !== null)
    .join(' · ');
}

export interface PayDraft {
  /** As typed ("400.000"). */
  readonly amount: string;
  readonly source: string;
  readonly reference: string;
}

/** A new payment for what is left on the bill, from the drawer. */
export function payDraftOf(bill: Pick<BillRow, 'balance'>): PayDraft {
  return {
    amount: bill.balance > 0 ? groupedRupiah(String(bill.balance)) : '',
    source: 'cash',
    reference: '',
  };
}

export function payAmount(draft: PayDraft): number | null {
  const amount = parseRupiah(draft.amount, MAX_PAYMENT);
  return amount === null || amount === 0 ? null : amount;
}

/** What still keeps the payment from being saved, or null. */
export function payGap(draft: PayDraft): PurchasingKey | null {
  return payAmount(draft) === null ? 'purchasing.pay.amountFirst' : null;
}

/** Paying more than is left: allowed, and said, since the rest becomes credit. */
export function payAboveBalance(draft: PayDraft, bill: Pick<BillRow, 'balance'>): boolean {
  const amount = payAmount(draft);
  return amount !== null && amount > bill.balance;
}

/** The `paySupplier` input for a complete draft. A reference is kept only for a bank transfer. */
export function payInput(draft: PayDraft, bill: Pick<BillRow, 'id' | 'supplierId'>) {
  const reference = draft.reference.trim();
  return {
    supplierId: bill.supplierId,
    billId: bill.id,
    amount: payAmount(draft) ?? 0,
    source: draft.source,
    reference: draft.source.startsWith('account:') && reference !== '' ? reference : null,
    note: null,
  };
}
