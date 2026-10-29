// The store's Kas, platform-free so the phone and the PC read it the same: what came in today by
// method, the drawer's moves, a count's difference and what customers still owe.
import { formatMoney } from '@bolusi/i18n';

import { CASH_ACCOUNT, HANDOVER_REFUND_REASON, movesOut, type CashMoveKind } from './constants.js';
import { tm, type MoneyKey } from './i18n.js';
import { paymentEntry, type PaymentEntry, type PaymentLine } from './payment-entry.js';
import type { CashCountRow, MoneyEntryRow, OpenBalanceRow, PaymentAccountRow } from './queries.js';

/** Local midnight of the day `now` falls in: "today" is the store's day, not UTC's. */
export function dayStart(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** A method's name, also for one switched off since: past money keeps the name it came in by. */
export function accountLabel(account: string, accounts: readonly PaymentAccountRow[]): string {
  if (account === CASH_ACCOUNT) return tm('money.method.cash');
  return accounts.find((row) => `account:${row.id}` === account)?.name ?? account;
}

export interface MethodTotal {
  readonly account: string;
  readonly amount: number;
}

/** The day's money in: payments by method, what went back, and the net of both. */
export interface MoneyIn {
  readonly methods: MethodTotal[];
  /** Handed back to customers, through any method: its own line, never a negative money in. */
  readonly refunded: number;
  readonly total: number;
}

/** The drawer first, then the rest by size. */
function byMethodOrder(totals: Map<string, number>): MethodTotal[] {
  return [...totals]
    .map(([account, amount]) => ({ account, amount }))
    .filter((total) => total.amount !== 0)
    .sort(
      (a, b) =>
        Number(b.account === CASH_ACCOUNT) - Number(a.account === CASH_ACCOUNT) ||
        b.amount - a.amount ||
        a.account.localeCompare(b.account),
    );
}

/**
 * Money in through each method over the records given (payments that still count); what was
 * handed back is its own figure, so a refund of an earlier day's payment never shows as a method's
 * negative money in.
 */
export function moneyIn(entries: readonly MoneyEntryRow[]): MoneyIn {
  const totals = new Map<string, number>();
  let refunded = 0;
  for (const entry of entries) {
    if (entry.account === null) continue;
    if (entry.kind === 'payment_received' && entry.voidedAt === null) {
      totals.set(entry.account, (totals.get(entry.account) ?? 0) + entry.amount);
    }
    if (entry.kind === 'refund_paid') refunded += entry.amount;
  }
  const methods = byMethodOrder(totals);
  const paid = methods.reduce((sum, method) => sum + method.amount, 0);
  return { methods, refunded, total: paid - refunded };
}

/** What is still in through each method on one document: its payments less what went back. */
export function moneyInByMethod(entries: readonly MoneyEntryRow[]): MethodTotal[] {
  const totals = new Map<string, number>();
  for (const entry of entries) {
    if (entry.account === null) continue;
    const amount =
      entry.kind === 'payment_received' && entry.voidedAt === null
        ? entry.amount
        : entry.kind === 'refund_paid'
          ? -entry.amount
          : 0;
    if (amount !== 0) totals.set(entry.account, (totals.get(entry.account) ?? 0) + amount);
  }
  return byMethodOrder(totals);
}

/** How each move reads, in the order the counter is offered them. */
export const CASH_MOVE_LABEL: Readonly<Record<CashMoveKind, MoneyKey>> = {
  withdrawal: 'money.moveKind.withdrawal',
  expense: 'money.moveKind.expense',
  deposit: 'money.moveKind.deposit',
  float: 'money.moveKind.float',
};

/** A change to the drawer the counter did not take at the counter: a move, or a settled difference. */
export interface DrawerMove {
  readonly entry: MoneyEntryRow;
  readonly label: MoneyKey;
  /** What it did to the drawer: positive in, negative out. */
  readonly delta: number;
}

/**
 * Today's cash moved in or out, with an owner's corrections, so the moves explain the drawer's
 * figure next to what came in.
 */
export function drawerMoves(entries: readonly MoneyEntryRow[]): DrawerMove[] {
  const moves: DrawerMove[] = [];
  for (const entry of entries) {
    if (entry.kind === 'cash_moved') {
      const kind = (entry.subKind ?? 'expense') as CashMoveKind;
      moves.push({
        entry,
        label: CASH_MOVE_LABEL[kind],
        delta: movesOut(kind) ? -entry.amount : entry.amount,
      });
    } else if (entry.kind === 'cash_adjusted') {
      moves.push({ entry, label: 'money.kas.adjusted', delta: entry.amount });
    }
  }
  return moves;
}

/**
 * The difference an owner still has to settle: the latest count's, when it is off and not settled.
 * Only the latest one: an earlier difference left unsettled is still in the book, so the next count
 * finds it again, and settling both would correct the drawer twice. `counts` is newest first, as
 * `cashDrawer` lists them (the server's rule orders them the same way).
 */
export function differenceToSettle(counts: readonly CashCountRow[]): CashCountRow | null {
  const latest = counts[0] ?? null;
  return latest !== null && latest.difference !== 0 && latest.settled === 0 ? latest : null;
}

/** The latest count made today, if any: whether today's Tutup kas is done. */
export function countToday(counts: readonly CashCountRow[], now: number): CashCountRow | null {
  const start = dayStart(now);
  return counts.find((count) => count.countedAt >= start) ?? null;
}

/** An open balance with the customer it is for, when the document's module can name them. */
export interface NamedBalance extends OpenBalanceRow {
  readonly customer: string | null;
}

/** The open balances, each with its customer's name. */
export function nameBalances(
  rows: readonly OpenBalanceRow[],
  customers: ReadonlyMap<string, string>,
): NamedBalance[] {
  return rows.map((row) => ({ ...row, customer: customers.get(row.documentId) ?? null }));
}

export interface OpenBalances<T extends OpenBalanceRow = OpenBalanceRow> {
  /** Customers who took their phone before paying it all, longest waiting first. */
  readonly owed: readonly T[];
  /** More was recorded than was due: the store owes it back. */
  readonly owedBack: readonly T[];
}

export function splitOpenBalances<T extends OpenBalanceRow>(rows: readonly T[]): OpenBalances<T> {
  return {
    owed: rows.filter((row) => row.balance > 0),
    owedBack: rows.filter((row) => row.balance < 0),
  };
}

/**
 * A record's reason as the history shows it. The handover refund's code reads in this reader's
 * language, and so do the fixed words older versions saved in its place.
 */
const HANDOVER_REFUND_WORDS = new Set([
  HANDOVER_REFUND_REASON,
  'Returned at handover',
  'Sisa DP dikembalikan saat serah terima',
  'Rest of the DP returned at handover',
]);

function reasonText(reason: string | null): string | null {
  return reason !== null && HANDOVER_REFUND_WORDS.has(reason)
    ? tm('money.history.handoverRefund')
    : reason;
}

/** How each kind of record reads in the day's history. */
const ENTRY_LABEL: Readonly<Record<string, MoneyKey>> = {
  charge_recorded: 'money.opType.chargeRecorded',
  charge_reduced: 'money.opType.chargeReduced',
  payment_received: 'money.opType.paymentReceived',
  refund_paid: 'money.opType.refundPaid',
  cash_counted: 'money.opType.cashCounted',
};

export interface HistoryLine {
  readonly label: MoneyKey;
  /**
   * The customer, the servisan, the method and the reason, as far as the record has them. A
   * cancelled one keeps whose and which method it was, and says why it was cancelled instead.
   */
  readonly details: readonly string[];
  /** Signed for the drawer's moves and refunds, as the amount reads. */
  readonly amount: string;
  readonly voided: boolean;
}

/** One record as the history lists it. */
export function historyLine(
  entry: MoneyEntryRow,
  accounts: readonly PaymentAccountRow[],
  customer: string | null = null,
): HistoryLine {
  // The drawer's own moves read as the board lists them.
  const move = drawerMoves([entry])[0];
  const label = move?.label ?? ENTRY_LABEL[entry.kind] ?? 'money.opType.paymentReceived';
  const method =
    entry.account === null ||
    !['payment_received', 'refund_paid', 'cash_moved'].includes(entry.kind)
      ? null
      : accountLabel(entry.account, accounts);
  const signed =
    move !== undefined
      ? move.delta
      : entry.kind === 'refund_paid' || entry.kind === 'charge_reduced'
        ? -entry.amount
        : entry.amount;
  const voided = entry.voidedAt !== null;
  return {
    label,
    details: [
      customer,
      entry.documentLabel,
      method,
      voided
        ? tm('money.history.voided', { reason: entry.voidReason ?? '' })
        : reasonText(entry.reason),
    ].filter((part): part is string => part !== null && part !== ''),
    amount: formatMoney(signed),
    voided,
  };
}

/** Whether an owner may still cancel this record: a payment not cancelled yet. */
export function voidable(entry: MoneyEntryRow): boolean {
  return entry.kind === 'payment_received' && entry.voidedAt === null;
}

/**
 * Whether someone may void this payment, given `ModulePort.limitOf(money.void_payment)`: anyone
 * unlimited, and a limited role (a manager) only a payment within its limit, so one it would be
 * refused is not offered. Earlier voids on the same servisan still count against it at the rule.
 */
export function voidOffered(entry: MoneyEntryRow, limit: number | null): boolean {
  return voidable(entry) && (limit === null || entry.amount <= limit);
}

/**
 * The count an owner is settling, as it stands now (a payment from before the count can sync while
 * they read), and whether it is still the one to settle.
 */
export function settleState(
  counts: readonly CashCountRow[] | null,
  count: CashCountRow,
): { readonly live: CashCountRow; readonly open: boolean } {
  return {
    live: counts?.find((row) => row.id === count.id) ?? count,
    open: counts === null || differenceToSettle(counts)?.id === count.id,
  };
}

/** "Kurang Rp 5.000" or "Lebih Rp 5.000": a count's difference as the counter says it. */
export function differenceText(difference: number): string {
  if (difference === 0) return tm('money.kas.exact');
  return tm(difference < 0 ? 'money.kas.short' : 'money.kas.over', {
    amount: formatMoney(Math.abs(difference)),
  });
}

export interface CashMoveCheck {
  /** The store's bank accounts a deposit can go into. */
  readonly banks: readonly PaymentAccountRow[];
  /** Where a deposit goes: the one picked, else the only or first bank account. */
  readonly depositAccount: PaymentAccountRow | null;
  /** What is still missing before it can be saved, in words; null when nothing is. */
  readonly missing: MoneyKey | null;
  /** The values `missing` reads with. */
  readonly missingValues?: { readonly amount: string };
}

/**
 * Cash out of or into the drawer: what it needs before it is saved. Cash is deposited into a bank
 * account; QRIS and card machines settle there on their own. Nobody takes out more than the book
 * says is in the drawer (`drawer`, null while it loads; the command checks again on save): the
 * server records real cash as it comes, so the device is where an over-withdrawal is stopped.
 */
export function cashMoveCheck(move: {
  readonly kind: CashMoveKind;
  readonly account: string | null;
  readonly amount: number | null;
  readonly reason: string;
  readonly accounts: readonly PaymentAccountRow[];
  readonly drawer: number | null;
}): CashMoveCheck {
  const banks = move.accounts.filter((row) => row.kind === 'transfer');
  const depositAccount =
    move.kind === 'deposit'
      ? (banks.find((row) => `account:${row.id}` === move.account) ?? banks[0] ?? null)
      : null;
  const aboveDrawer =
    move.amount !== null &&
    movesOut(move.kind) &&
    move.drawer !== null &&
    move.amount > move.drawer;
  if (aboveDrawer) {
    return {
      banks,
      depositAccount,
      missing: 'money.move.aboveDrawer',
      missingValues: { amount: formatMoney(Math.max(0, move.drawer ?? 0)) },
    };
  }
  const missing: MoneyKey | null =
    move.amount === null || move.amount <= 0
      ? 'money.move.hintAmount'
      : move.reason.trim() === ''
        ? 'money.move.hintReason'
        : move.kind === 'deposit' && depositAccount === null
          ? 'money.move.noAccount'
          : null;
  return { banks, depositAccount, missing };
}

export interface DebtPayment {
  /** The lines against the whole debt: what is left, what is over. */
  readonly entry: PaymentEntry;
  /** What is recorded: the amount typed, which may be part of the debt; null while nothing is. */
  readonly taken: PaymentEntry | null;
}

/**
 * A customer paying (part of) a debt for a phone they already took home. Part of it is fine, so
 * what is recorded is what was typed; more than the debt is not.
 */
export function debtPayment(
  owed: number,
  lines: readonly PaymentLine[],
  accounts: readonly PaymentAccountRow[],
  qrAccounts?: ReadonlySet<string>,
): DebtPayment {
  const entry = paymentEntry(owed, lines, accounts, qrAccounts);
  const taken =
    entry.paid > 0 && entry.overpaid === 0
      ? paymentEntry(entry.paid, lines, accounts, qrAccounts)
      : null;
  return { entry, taken };
}
