// The store's Kas, platform-free so the phone and the PC read it the same: what came in today by
// method, the drawer's moves, a count's difference and what customers still owe.
import { CASH_ACCOUNT, type CashMoveKind } from './constants.js';
import { tm, type MoneyKey } from './i18n.js';
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

/**
 * Money in through each method over the records given: payments that still count, less what was
 * handed back through that method. The drawer first, then the rest by size.
 */
export function moneyInByMethod(entries: readonly MoneyEntryRow[]): MethodTotal[] {
  const totals = new Map<string, number>();
  const add = (account: string, amount: number) =>
    totals.set(account, (totals.get(account) ?? 0) + amount);
  for (const entry of entries) {
    if (entry.account === null) continue;
    if (entry.kind === 'payment_received' && entry.voidedAt === null) {
      add(entry.account, entry.amount);
    }
    if (entry.kind === 'refund_paid') add(entry.account, -entry.amount);
  }
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

/** Whether a move takes cash out of the drawer (everything but change money put in). */
export function movesOut(kind: CashMoveKind): boolean {
  return kind !== 'float';
}

/** How each move reads, in the order the counter is offered them. */
export const CASH_MOVE_LABEL: Readonly<Record<CashMoveKind, MoneyKey>> = {
  withdrawal: 'money.moveKind.withdrawal',
  expense: 'money.moveKind.expense',
  deposit: 'money.moveKind.deposit',
  float: 'money.moveKind.float',
};

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
