// Taking a payment at a counter, platform-free so the phone and the PC (and a till later) work
// the same: one or more lines, each a method and an amount, against what is due. A cash line may
// carry what the customer handed over, so the screen can show the change; an EDC line needs its
// approval code (`referenceRequired`).
import { CASH_ACCOUNT, referenceRequired, type PaymentAccountKind } from './constants.js';
import type { PaymentInput } from './commands.js';
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
}

export type PaymentLineProblem = 'amount' | 'reference' | 'tendered';

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

/** Whole rupiah from typed digits; null when empty. */
function rupiah(text: string): number | null {
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

export function paymentEntry(
  due: number,
  lines: readonly PaymentLine[],
  accounts: readonly PaymentAccountRow[],
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
    const kind = lineKind(line.account, accounts);
    const reference = line.reference.trim();
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
      account: line.account,
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
