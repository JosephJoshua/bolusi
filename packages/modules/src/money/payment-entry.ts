// Taking a payment at a counter, platform-free so the phone and the PC (and a till later) work
// the same: one or more lines, each a method and an amount, against what is due. A cash line may
// carry what the customer handed over, so the screen can show the change; an EDC line needs its
// approval code (`referenceRequired`). A QRIS line on a method connected to Xendit is paid by
// showing the customer a QR (qris-hooks.ts): it is never recorded from here, since the server
// records the payment once Xendit confirms it, unless the counter falls back to taking it by hand.
import { formatNumber } from '@bolusi/i18n';
import { QRIS_MIN_AMOUNT } from '@bolusi/schemas';

import { CASH_ACCOUNT, referenceRequired, type PaymentAccountKind } from './constants.js';
import type { PaymentInput } from './commands.js';
import { tm } from './i18n.js';
import type { PaymentAccountRow } from './queries.js';

/** What the counter typed for one method. Amounts are digits as typed, '' when empty. */
export interface PaymentLine {
  readonly key: string;
  /** `cash` or `account:<id>`. */
  readonly account: string;
  readonly amount: string;
  /** Cash handed over, for the change; cash lines only. */
  readonly tendered: string;
  readonly reference: string;
  /** The QR shown for this line: its charge id, for the amount it was made for. */
  readonly qr?: { readonly id: string; readonly amount: number } | undefined;
  /** Taken by hand on a method connected to Xendit (offline, or Xendit not answering). */
  readonly manual?: boolean | undefined;
}

/**
 * `method`: the store switched the line's method off since it was picked.
 * `qr`: still to be paid by the customer scanning its QR.
 */
export type PaymentLineProblem = 'amount' | 'method' | 'reference' | 'tendered' | 'qr';

export interface PaymentEntry {
  /** The payments to record, once every line is complete; empty while one is not. */
  readonly payments: readonly PaymentInput[];
  /** The sum of the amounts typed. */
  readonly paid: number;
  /** Still to pay after them; never below zero. */
  readonly remaining: number;
  /** More typed than is due: an amount to lower, not change to give. */
  readonly overpaid: number;
  /** Change to hand back on cash lines with what was handed over. */
  readonly change: number;
  readonly problems: Readonly<Record<string, PaymentLineProblem>>;
  /** Every line is complete and together they pay exactly what is due. */
  readonly complete: boolean;
}

const MAX_DIGITS = 13;

const NO_QR_ACCOUNTS: ReadonlySet<string> = new Set();

/** The digits of what was typed into an amount field, or null when it is too long to be money. */
export function digitsOf(text: string): string | null {
  const digits = text.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  return digits.length > MAX_DIGITS ? null : digits;
}

/** "650.000" for typed digits, empty for none: the amount reads as the customer hears it. */
export function digitsText(digits: string): string {
  return digits === '' ? '' : formatNumber(Number(digits));
}

/** Whole rupiah from typed digits; null when empty. */
export function rupiah(text: string): number | null {
  const digits = text.replace(/\D/g, '');
  return digits === '' ? null : Number(digits);
}

/** The kind of the method a line names; cash for the drawer. */
export function lineKind(
  account: string,
  accounts: readonly PaymentAccountRow[],
): PaymentAccountKind | 'cash' {
  if (account === CASH_ACCOUNT) return 'cash';
  return accounts.find((row) => `account:${row.id}` === account)?.kind ?? 'cash';
}

/**
 * Whether a line is paid by its QR rather than recorded here. Below what QRIS takes there is no QR,
 * so such a line is taken by hand.
 */
export function paidByQr(line: PaymentLine, qrAccounts: ReadonlySet<string>): boolean {
  const amount = rupiah(line.amount);
  return (
    line.manual !== true &&
    qrAccounts.has(line.account) &&
    (amount === null || amount >= QRIS_MIN_AMOUNT)
  );
}

/**
 * `qrAccounts` are the methods (`account:<id>`) connected to Xendit here: their lines count toward
 * what is paid, so the rest adds up, but stay incomplete until the customer pays the QR.
 */
export function paymentEntry(
  due: number,
  lines: readonly PaymentLine[],
  accounts: readonly PaymentAccountRow[],
  qrAccounts: ReadonlySet<string> = NO_QR_ACCOUNTS,
): PaymentEntry {
  const problems: Record<string, PaymentLineProblem> = {};
  const payments: PaymentInput[] = [];
  let paid = 0;
  let change = 0;
  for (const line of lines) {
    const amount = rupiah(line.amount);
    if (amount === null || amount <= 0) {
      problems[line.key] = 'amount';
      continue;
    }
    paid += amount;
    // A method switched off while the line was open is picked again, never booked to the drawer.
    const account = line.account;
    if (!methodOffered(account, accounts)) {
      problems[line.key] = 'method';
      continue;
    }
    if (paidByQr(line, qrAccounts)) {
      problems[line.key] = 'qr';
      continue;
    }
    const kind = lineKind(account, accounts);
    const reference = kind === 'cash' ? '' : line.reference.trim();
    if (referenceRequired(kind) && reference === '') {
      problems[line.key] = 'reference';
      continue;
    }
    const tendered = kind === 'cash' ? rupiah(line.tendered) : null;
    if (tendered !== null && tendered < amount) {
      problems[line.key] = 'tendered';
      continue;
    }
    if (tendered !== null) change += tendered - amount;
    payments.push({
      account,
      amount,
      reference: reference === '' ? null : reference,
      tendered,
    });
  }
  const complete = Object.keys(problems).length === 0 && paid === due && due > 0;
  return {
    payments: complete ? payments : [],
    paid,
    remaining: Math.max(0, due - paid),
    overpaid: Math.max(0, paid - due),
    change,
    problems,
    complete,
  };
}

/** A new line for what is still due: the drawer, unless the counter picks another method. */
export function newPaymentLine(
  key: string,
  remaining: number,
  account: string = CASH_ACCOUNT,
): PaymentLine {
  return {
    key,
    account,
    amount: remaining > 0 ? String(remaining) : '',
    tendered: '',
    reference: '',
  };
}

/** Whether the store still offers a method picked earlier: the drawer always. */
export function methodOffered(account: string, accounts: readonly PaymentAccountRow[]): boolean {
  return account === CASH_ACCOUNT || accounts.some((row) => `account:${row.id}` === account);
}

/**
 * The method a payment goes through, as offered here: the one picked while the store still offers
 * it, the drawer otherwise (an account switched off since a draft picked it).
 */
export function offeredAccount(account: string, accounts: readonly PaymentAccountRow[]): string {
  return methodOffered(account, accounts) ? account : CASH_ACCOUNT;
}

/** Whether a single payment (a DP) still needs the reference its method asks for (an EDC code). */
export function referenceMissing(
  account: string,
  reference: string,
  accounts: readonly PaymentAccountRow[],
): boolean {
  return (
    referenceRequired(lineKind(offeredAccount(account, accounts), accounts)) &&
    reference.trim() === ''
  );
}

export interface PaymentMethod {
  /** `cash` or `account:<id>`. */
  readonly account: string;
  readonly label: string;
}

/** The methods a counter picks from, the drawer first. */
export function paymentMethods(accounts: readonly PaymentAccountRow[]): PaymentMethod[] {
  return [
    { account: CASH_ACCOUNT, label: tm('money.method.cash') },
    ...accounts.map((row) => ({ account: `account:${row.id}`, label: row.name })),
  ];
}

/** A single payment's method as it is sent: the offered account, and a reference unless cash. */
export function chosenMethod(
  account: string,
  reference: string,
  accounts: readonly PaymentAccountRow[],
): { readonly account: string; readonly reference: string | null } {
  const offered = offeredAccount(account, accounts);
  const trimmed = reference.trim();
  return {
    account: offered,
    reference: offered === CASH_ACCOUNT || trimmed === '' ? null : trimmed,
  };
}
