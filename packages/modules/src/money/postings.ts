// The posting rules: which ledger accounts each money record debits and credits. This is the one
// place bookkeeping is decided, so the counter never sees a journal and every entry balances by
// construction. A later accounting module reads `money_lines`; it never re-derives them.
import { CASH_ACCOUNT, SYSTEM_ACCOUNT, type CashMoveKind, type EntryKind } from './constants.js';

export interface Posting {
  readonly account: string;
  readonly debit: number;
  readonly credit: number;
}

/** The fields of a record its posting depends on. */
export interface PostingInput {
  readonly kind: EntryKind;
  readonly amount: number;
  /** The payment account (payments, refunds, deposits) or the revenue account (charges). */
  readonly account: string | null;
  readonly subKind: string | null;
}

const dr = (account: string, amount: number): Posting => ({ account, debit: amount, credit: 0 });
const cr = (account: string, amount: number): Posting => ({ account, debit: 0, credit: amount });

function cashMove(kind: CashMoveKind, amount: number, account: string | null): Posting[] {
  switch (kind) {
    case 'withdrawal':
      return [dr(SYSTEM_ACCOUNT.ownerDraw, amount), cr(CASH_ACCOUNT, amount)];
    case 'expense':
      return [dr(SYSTEM_ACCOUNT.expense, amount), cr(CASH_ACCOUNT, amount)];
    case 'deposit':
      return [dr(account ?? CASH_ACCOUNT, amount), cr(CASH_ACCOUNT, amount)];
    case 'float':
      return [dr(CASH_ACCOUNT, amount), cr(SYSTEM_ACCOUNT.ownerCapital, amount)];
  }
}

/** The balanced lines of one record. A count posts nothing: only an owner's adjustment does. */
export function postingsFor(input: PostingInput): Posting[] {
  const { amount, account } = input;
  const receivable = SYSTEM_ACCOUNT.receivable;
  switch (input.kind) {
    case 'charge_recorded':
      return [dr(receivable, amount), cr(account ?? SYSTEM_ACCOUNT.serviceRevenue, amount)];
    case 'charge_reduced':
      return [dr(SYSTEM_ACCOUNT.revenueAdjustment, amount), cr(receivable, amount)];
    case 'payment_received':
      return [dr(account ?? CASH_ACCOUNT, amount), cr(receivable, amount)];
    case 'refund_paid':
      return [dr(receivable, amount), cr(account ?? CASH_ACCOUNT, amount)];
    case 'cash_moved':
      return cashMove(input.subKind as CashMoveKind, amount, account);
    case 'cash_counted':
      return [];
    case 'cash_adjusted':
      return amount >= 0
        ? [dr(CASH_ACCOUNT, amount), cr(SYSTEM_ACCOUNT.cashOverShort, amount)]
        : [dr(SYSTEM_ACCOUNT.cashOverShort, -amount), cr(CASH_ACCOUNT, -amount)];
  }
}

/** A void reverses a record's lines exactly. */
export function reversalOf(postings: readonly Posting[]): Posting[] {
  return postings.map((p) => ({ account: p.account, debit: p.credit, credit: p.debit }));
}
