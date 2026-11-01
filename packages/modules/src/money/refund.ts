// Money back to a customer, and an owner lowering what a customer owes: the state the phone's steps
// and the PC's dialogs share (owner decisions, 2026-10-28).
//
// The counter gives back only what the customer paid beyond their bill, through the method it came
// in by (rules.ts refundPaidRule). An owner gives back what was paid, any part of it, also after the
// phone went home: beyond the overpayment the bill is lowered by the difference first
// (commands.ts refundHandler), so the customer does not end up owing it. Either way it goes back
// through a method the customer paid with, as much as went in through it. A manager beyond their
// limit asks an owner instead, from the servisan (approval-kinds.ts), for the same refund or cut.
import { formatMoney } from '@bolusi/i18n';
import { useMemo, useState } from 'react';

import { APPROVAL_PERMISSION } from '../approvals/constants.js';
import { CASH_ACCOUNT, MONEY_APPROVAL_KIND, MONEY_PERMISSION } from './constants.js';
import type { RefundInput, ReduceChargeInput } from './commands.js';
import type { MoneyDocument } from './documents.js';
import { accountLabel, moneyInByMethod, type NamedBalance } from './kas.js';
import { tm } from './i18n.js';
import { rupiah } from './payment-entry.js';
import type { DocumentMoney, PaymentAccountRow } from './queries.js';
import { useMoneyQuery, useMoneyRuntime, type MoneyRuntime } from './runtime.js';

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

/** An approval request a form sends instead of saving, when the amount is beyond the limit. */
export interface MoneyAsk {
  readonly kind: string;
  readonly input: Record<string, unknown>;
  readonly reason: string;
}

/** A limited role (a manager) beyond its limit asks an owner, where the step lets it ask. */
function mayAskBeyond(runtime: MoneyRuntime, limit: number | null): boolean {
  return limit !== null && runtime.approvals.hasPermission(APPROVAL_PERMISSION.use);
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
  /**
   * The most the picked method can give back, within a limited role's limit unless beyond it is
   * asked for.
   */
  readonly max: number;
  /** A limited role's (a manager's) refund limit per document; null when not limited. */
  readonly limit: number | null;
  /** The amount is above `max` because of `limit`, not the method, and nobody can be asked. */
  readonly overLimit: boolean;
  /** The amount is above `limit`, so saving asks an owner for it instead (`ask`). */
  readonly asking: boolean;
  /** Beyond the limit here, an owner can be asked from the servisan instead (Kas). */
  readonly askElsewhere: boolean;
  readonly reason: string;
  readonly setReason: (reason: string) => void;
  /** Not for cash: the transfer's or reversal's number, if there is one. */
  readonly reference: string;
  readonly setReference: (reference: string) => void;
  /** An owner giving back beyond the overpayment lowers the bill by this much. */
  readonly lowersBill: number;
  readonly problem: RefundProblem | null;
  readonly dirty: boolean;
  /** What saving records, unless `asking`. */
  readonly input: RefundInput | null;
  /** What saving asks for when `asking`. */
  readonly ask: MoneyAsk | null;
}

/** `askable`: the step can send an approval request (on a servisan, where its answer shows). */
export function useRefund(target: MoneyTarget, askable = false): RefundForm {
  const runtime = useMoneyRuntime();
  const owner = runtime.hasPermission(MONEY_PERMISSION.refund);
  const limit = owner ? runtime.limitOf(MONEY_PERMISSION.refund) : null;
  const canAsk = mayAskBeyond(runtime, limit);
  const mayAsk = askable && canAsk;
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
  // Beyond the limit is asked for, when it can be; never beyond what the method can give back.
  const most = mayAsk ? methodMax : max;
  const problem: RefundProblem | null =
    method === null
      ? 'method'
      : amount === null || amount <= 0
        ? 'amount'
        : amount > most
          ? 'tooMuch'
          : reason.trim() === ''
            ? 'reason'
            : null;
  /** '' while no method is picked. */
  const account = method?.account ?? '';
  const trimmed = reference.trim();
  const asking = amount !== null && amount > max && problem !== 'tooMuch' && mayAsk;
  const input: RefundInput | null =
    problem !== null || method === null || amount === null
      ? null
      : {
          document: target.document,
          account,
          amount,
          reason: reason.trim(),
          reference: account === CASH_ACCOUNT || trimmed === '' ? null : trimmed,
        };
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
    max: most,
    limit,
    overLimit: problem === 'tooMuch' && most < methodMax,
    asking,
    askElsewhere: canAsk && !askable && problem === 'tooMuch' && most < methodMax,
    reason,
    setReason,
    reference,
    setReference,
    // What the typed amount would do; nothing while the amount itself is refused.
    lowersBill: amount === null || problem === 'tooMuch' ? 0 : Math.max(0, amount - credit),
    problem,
    dirty: typed !== null || picked !== null || reason.trim() !== '' || trimmed !== '',
    input: asking ? null : input,
    ask:
      asking && input !== null && method !== null
        ? {
            kind: MONEY_APPROVAL_KIND.refund,
            input: { ...input, methodLabel: method.label },
            reason: input.reason,
          }
        : null,
  };
}

export type ReduceProblem = 'amount' | 'tooMuch' | 'reason';

export interface ReduceChargeForm {
  readonly ready: boolean;
  /** What the customer still owes. */
  readonly owed: number;
  /**
   * The most the bill can come down: what was charged, less what was taken off before, and for a
   * limited role no further than its limit unless beyond it is asked for.
   */
  readonly max: number;
  /** A limited role's limit on what is taken off a document; null when not limited. */
  readonly limit: number | null;
  /** The amount is above `max` because of `limit`, and nobody can be asked. */
  readonly overLimit: boolean;
  /** The amount is above `limit`, so saving asks an owner for it instead (`ask`). */
  readonly asking: boolean;
  /** Beyond the limit here, an owner can be asked from the servisan instead (Kas). */
  readonly askElsewhere: boolean;
  readonly digits: string;
  readonly setDigits: (digits: string) => void;
  readonly reason: string;
  readonly setReason: (reason: string) => void;
  /** Owed after it (below zero: the store owes the customer). */
  readonly after: number;
  readonly problem: ReduceProblem | null;
  readonly dirty: boolean;
  /** What saving records, unless `asking`. */
  readonly input: ReduceChargeInput | null;
  /** What saving asks for when `asking`. */
  readonly ask: MoneyAsk | null;
}

/**
 * An owner lowers a bill already charged; the whole debt is filled in. `askable`: the step can send
 * an approval request (on a servisan).
 */
export function useReduceCharge(target: MoneyTarget, askable = false): ReduceChargeForm {
  const runtime = useMoneyRuntime();
  const limit = runtime.limitOf(MONEY_PERMISSION.refund);
  const canAsk = mayAskBeyond(runtime, limit);
  const mayAsk = askable && canAsk;
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
  const most = mayAsk ? chargedMax : max;
  const problem: ReduceProblem | null =
    amount === null || amount <= 0
      ? 'amount'
      : amount > most
        ? 'tooMuch'
        : reason.trim() === ''
          ? 'reason'
          : null;
  const asking = amount !== null && amount > max && problem !== 'tooMuch' && mayAsk;
  const input: ReduceChargeInput | null =
    problem !== null || amount === null
      ? null
      : { document: target.document, amount, reason: reason.trim() };
  return {
    ready: money !== null,
    owed,
    max: most,
    limit,
    overLimit: problem === 'tooMuch' && most < chargedMax,
    asking,
    askElsewhere: canAsk && !askable && problem === 'tooMuch' && most < chargedMax,
    digits,
    setDigits,
    reason,
    setReason,
    // Never past what the bill can come down, so a typed overshoot does not read as money owed back.
    // What the typed amount would leave; the debt as it is while the amount itself is refused.
    after: problem === 'tooMuch' ? owed : owed - (amount ?? 0),
    problem,
    dirty: typed !== null || reason.trim() !== '',
    input: asking ? null : input,
    ask:
      asking && input !== null
        ? { kind: MONEY_APPROVAL_KIND.reduceCharge, input: { ...input }, reason: input.reason }
        : null,
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
export function refundLimitText(
  form: Pick<RefundForm, 'limit' | 'overLimit' | 'asking'>,
): string | null {
  if (form.limit === null || form.overLimit) return null;
  if (form.asking) return tm('money.ask.overLimit');
  return tm('money.refund.limit', { amount: formatMoney(form.limit) });
}

export function reduceLimitText(
  form: Pick<ReduceChargeForm, 'limit' | 'overLimit' | 'asking'>,
): string | null {
  if (form.limit === null || form.overLimit) return null;
  if (form.asking) return tm('money.ask.overLimit');
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
export function refundHint(
  form: Pick<RefundForm, 'ready' | 'problem' | 'methods' | 'askElsewhere'>,
): string | null {
  // With nothing to give back, the step says so instead.
  if (!form.ready || form.methods.length === 0) return null;
  if (form.askElsewhere) return tm('money.ask.fromServisan');
  if (form.problem === null || form.problem === 'tooMuch') return null;
  return tm(`money.refund.hint.${form.problem}`);
}

export function reduceHint(
  form: Pick<ReduceChargeForm, 'ready' | 'problem' | 'askElsewhere'>,
): string | null {
  if (form.ready && form.askElsewhere) return tm('money.ask.fromServisan');
  if (!form.ready || form.problem === null || form.problem === 'tooMuch') return null;
  return tm(`money.reduce.hint.${form.problem}`);
}
