// Money back to a customer, and an owner lowering what a customer owes: the state the phone's steps
// and the PC's dialogs share (owner decisions, 2026-10-28).
//
// The counter gives back only what the customer paid beyond their bill, through the method it came
// in by (rules.ts refundPaidRule). An owner gives back what was paid, any part of it, also after the
// phone went home: beyond the overpayment the bill is lowered by the difference first
// (commands.ts refundHandler), so the customer does not end up owing it. Either way it goes back
// through a method the customer paid with, as much as went in through it.
import { formatMoney } from '@bolusi/i18n';
import { useMemo, useState } from 'react';

import { CASH_ACCOUNT, MONEY_PERMISSION } from './constants.js';
import type { RefundInput, ReduceChargeInput } from './commands.js';
import type { MoneyDocument } from './documents.js';
import { accountLabel, moneyInByMethod, type NamedBalance } from './kas.js';
import { tm } from './i18n.js';
import { rupiah } from './payment-entry.js';
import type { DocumentMoney, PaymentAccountRow } from './queries.js';
import { useMoneyQuery, useMoneyRuntime } from './runtime.js';

/** What money goes back for, and whose it is. */
export interface MoneyTarget {
  readonly document: MoneyDocument;
  readonly customer: string | null;
}

export function targetOf(balance: NamedBalance): MoneyTarget {
  return {
    document: { kind: balance.documentKind, id: balance.documentId, label: balance.documentLabel },
    customer: balance.customer,
  };
}

/** A method money can go back through, and the most that can. */
export interface RefundMethod {
  readonly account: string;
  readonly label: string;
  readonly limit: number;
}

/**
 * The methods a refund can go through: those the customer paid with, net of what already went
 * back through them. The counter is held to the overpayment as well.
 */
export function refundMethods(
  money: DocumentMoney,
  accounts: readonly PaymentAccountRow[],
  owner: boolean,
): RefundMethod[] {
  const credit = Math.max(0, -money.balance);
  return moneyInByMethod(money.entries)
    .filter((total) => total.amount > 0)
    .map((total) => ({
      account: total.account,
      label: accountLabel(total.account, accounts),
      limit: owner ? total.amount : Math.min(credit, total.amount),
    }))
    .filter((method) => method.limit > 0);
}

/** Live: a payment or refund that syncs in changes what can go back. */
function useDocumentMoney(document: MoneyDocument) {
  const money = useMoneyQuery(
    async (rt) =>
      (await rt.query('documentMoney', { kind: document.kind, id: document.id })).rows[0] ?? null,
    `documentMoney:${document.id}`,
  );
  const accounts = useMoneyQuery(
    async (rt) => (await rt.query('paymentAccounts', { includeInactive: true })).rows,
    'accounts:all',
  );
  return {
    money: money.status === 'ready' ? money.data : null,
    accounts: accounts.status === 'ready' ? accounts.data : null,
  };
}

export type RefundProblem = 'method' | 'amount' | 'tooMuch' | 'reason';

export interface RefundForm {
  /** The document's money and the store's methods have loaded. */
  readonly ready: boolean;
  /** Gives back beyond the overpayment, after pickup too. */
  readonly owner: boolean;
  /** What the customer paid beyond their bill. */
  readonly credit: number;
  /** What the customer paid that still counts. */
  readonly paid: number;
  readonly methods: readonly RefundMethod[];
  /** The method picked; '' when none is. */
  readonly account: string;
  readonly setAccount: (account: string) => void;
  /** The amount as typed, digits only. */
  readonly digits: string;
  readonly setDigits: (digits: string) => void;
  /** The most the picked method can give back, within a limited role's limit. */
  readonly max: number;
  /** A limited role's (a manager's) refund limit per document; null when not limited. */
  readonly limit: number | null;
  /** The amount is above `max` because of `limit`, not the method. */
  readonly overLimit: boolean;
  readonly reason: string;
  readonly setReason: (reason: string) => void;
  /** Not for cash: the transfer's or reversal's number, if there is one. */
  readonly reference: string;
  readonly setReference: (reference: string) => void;
  /** An owner giving back beyond the overpayment lowers the bill by this much. */
  readonly lowersBill: number;
  readonly problem: RefundProblem | null;
  readonly dirty: boolean;
  readonly input: RefundInput | null;
}

export function useRefund(target: MoneyTarget): RefundForm {
  const runtime = useMoneyRuntime();
  const owner = runtime.hasPermission(MONEY_PERMISSION.refund);
  const limit = owner ? runtime.limitOf(MONEY_PERMISSION.refund) : null;
  const { money, accounts } = useDocumentMoney(target.document);
  const methods = useMemo(
    () => (money === null || accounts === null ? [] : refundMethods(money, accounts, owner)),
    [money, accounts, owner],
  );
  const [picked, setAccount] = useState<string | null>(null);
  const [typed, setDigits] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');

  // A method picked by hand stays picked: if a refund through it syncs in and uses it up, nothing
  // else is chosen in its place, so the money never goes back some way the counter did not pick.
  const method =
    picked === null ? (methods[0] ?? null) : (methods.find((m) => m.account === picked) ?? null);
  const credit = money === null ? 0 : Math.max(0, -money.balance);
  const methodMax = method?.limit ?? 0;
  const max =
    money === null || limit === null ? methodMax : withinRefundLimit(money, methodMax, limit);
  // Until typed, the overpayment (all of it that this method can give back).
  const digits = typed ?? (credit > 0 ? String(Math.min(credit, max)) : '');
  const amount = rupiah(digits);
  const problem: RefundProblem | null =
    method === null
      ? 'method'
      : amount === null || amount <= 0
        ? 'amount'
        : amount > max
          ? 'tooMuch'
          : reason.trim() === ''
            ? 'reason'
            : null;
  /** '' while no method is picked. */
  const account = method?.account ?? '';
  const trimmed = reference.trim();
  return {
    ready: money !== null && accounts !== null,
    owner,
    credit,
    paid: money?.paid ?? 0,
    methods,
    account,
    setAccount: (next) => {
      setAccount(next);
      setReference('');
      setDigits(null);
    },
    digits,
    setDigits,
    max,
    limit,
    overLimit: problem === 'tooMuch' && max < methodMax,
    reason,
    setReason,
    reference,
    setReference,
    lowersBill: amount === null ? 0 : Math.max(0, Math.min(amount, max) - credit),
    problem,
    dirty: typed !== null || picked !== null || reason.trim() !== '' || trimmed !== '',
    input:
      problem !== null || method === null || amount === null
        ? null
        : {
            document: target.document,
            account,
            amount,
            reason: reason.trim(),
            reference: account === CASH_ACCOUNT || trimmed === '' ? null : trimmed,
          },
  };
}

export type ReduceProblem = 'amount' | 'tooMuch' | 'reason';

export interface ReduceChargeForm {
  readonly ready: boolean;
  /** What the customer still owes. */
  readonly owed: number;
  /**
   * The most the bill can come down: what was charged, less what was taken off before, and for a
   * limited role no further than its limit.
   */
  readonly max: number;
  /** A limited role's limit on what is taken off a document; null when not limited. */
  readonly limit: number | null;
  /** The amount is above `max` because of `limit`. */
  readonly overLimit: boolean;
  readonly digits: string;
  readonly setDigits: (digits: string) => void;
  readonly reason: string;
  readonly setReason: (reason: string) => void;
  /** Owed after it (below zero: the store owes the customer). */
  readonly after: number;
  readonly problem: ReduceProblem | null;
  readonly dirty: boolean;
  readonly input: ReduceChargeInput | null;
}

/** An owner lowers a bill already charged; the whole debt is filled in. */
export function useReduceCharge(target: MoneyTarget): ReduceChargeForm {
  const limit = useMoneyRuntime().limitOf(MONEY_PERMISSION.refund);
  const { money } = useDocumentMoney(target.document);
  const [typed, setDigits] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const owed = money === null ? 0 : money.balance;
  const chargedMax = money === null ? 0 : money.charged - money.reduced;
  // As the server counts it (rules.ts chargeReducedRule): all taken off the document, this too.
  const max =
    money === null || limit === null
      ? chargedMax
      : Math.max(0, Math.min(chargedMax, limit - money.reduced));
  const digits = typed ?? (owed > 0 ? String(Math.min(owed, max)) : '');
  const amount = rupiah(digits);
  const problem: ReduceProblem | null =
    amount === null || amount <= 0
      ? 'amount'
      : amount > max
        ? 'tooMuch'
        : reason.trim() === ''
          ? 'reason'
          : null;
  return {
    ready: money !== null,
    owed,
    max,
    limit,
    overLimit: problem === 'tooMuch' && max < chargedMax,
    digits,
    setDigits,
    reason,
    setReason,
    // Never past what the bill can come down, so a typed overshoot does not read as money owed back.
    after: owed - Math.min(amount ?? 0, max),
    problem,
    dirty: typed !== null || reason.trim() !== '',
    input:
      problem !== null || amount === null
        ? null
        : { document: target.document, amount, reason: reason.trim() },
  };
}

/**
 * The most a limited role (a manager) may give back through a method, counted as the server does
 * (rules.ts refundPaidRule): within the overpayment it is the counter's refund, which no limit
 * holds; beyond it, every refund on the document and what the bill comes down by (commands.ts
 * refundHandler) must each stay within the limit.
 */
export function withinRefundLimit(money: DocumentMoney, methodMax: number, limit: number): number {
  // Before anything is charged, no refund is the counter's (a DP is not an overpayment yet).
  const credit = money.charged > 0 ? Math.max(0, -money.balance) : 0;
  const refunded = money.entries
    .filter((entry) => entry.kind === 'refund_paid')
    .reduce((sum, entry) => sum + entry.amount, 0);
  const limited = Math.min(limit - refunded, limit - money.reduced + credit);
  return Math.min(methodMax, Math.max(Math.min(credit, methodMax), limited));
}

/**
 * Under the amount: a limited role's limit, before the save would refuse it. Not while the amount's
 * own error already says how far it may go.
 */
export function refundLimitText(form: Pick<RefundForm, 'limit' | 'overLimit'>): string | null {
  if (form.limit === null || form.overLimit) return null;
  return tm('money.refund.limit', { amount: formatMoney(form.limit) });
}

export function reduceLimitText(
  form: Pick<ReduceChargeForm, 'limit' | 'overLimit'>,
): string | null {
  if (form.limit === null || form.overLimit) return null;
  return tm('money.reduce.limit', { amount: formatMoney(form.limit) });
}

/** The amount's error: above what the method (or the limit) allows. */
export function refundAmountError(
  form: Pick<RefundForm, 'problem' | 'max' | 'overLimit'>,
): string | undefined {
  if (form.problem !== 'tooMuch') return undefined;
  return tm(form.overLimit ? 'money.refund.overLimit' : 'money.refund.tooMuch', {
    amount: formatMoney(form.max),
  });
}

export function reduceAmountError(
  form: Pick<ReduceChargeForm, 'problem' | 'max' | 'overLimit'>,
): string | undefined {
  if (form.problem !== 'tooMuch') return undefined;
  return tm(form.overLimit ? 'money.reduce.overLimit' : 'money.reduce.tooMuch', {
    amount: formatMoney(form.max),
  });
}

/**
 * What still stands before saving, said under the button; nothing for an amount above the most,
 * which its field already says.
 */
export function refundHint(form: Pick<RefundForm, 'ready' | 'problem' | 'methods'>): string | null {
  // With nothing to give back, the step says so instead.
  if (!form.ready || form.methods.length === 0) return null;
  if (form.problem === null || form.problem === 'tooMuch') return null;
  return tm(`money.refund.hint.${form.problem}`);
}

export function reduceHint(form: Pick<ReduceChargeForm, 'ready' | 'problem'>): string | null {
  if (!form.ready || form.problem === null || form.problem === 'tooMuch') return null;
  return tm(`money.reduce.hint.${form.problem}`);
}
