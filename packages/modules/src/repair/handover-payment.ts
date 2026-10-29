// What the counter enters to settle a handover, the same on the phone and the PC: the payment
// lines for what is due, or (an owner only) "Bayar nanti" with a reason, which leaves a debt. A
// QRIS line on a method connected to Xendit is paid by its QR (money/qris-hooks.ts); the handover
// then waits for that payment to sync, since the ledger must show the phone paid in full.
import { useRef, useState } from 'react';

import {
  newPaymentLine,
  paymentEntry,
  type PaymentEntry,
  type PaymentLine,
} from '../money/payment-entry.js';
import type { MoneyDocument } from '../money/documents.js';
import { useQrisCheckout, type QrisCheckout } from '../money/qris-hooks.js';
import type { QrisPort } from '../money/qris.js';
import type { PaymentAccountRow } from '../money/queries.js';
import type { ReturnDeviceInput } from './commands.js';

export interface HandoverPayment {
  readonly lines: readonly PaymentLine[];
  readonly setLines: (lines: readonly PaymentLine[]) => void;
  readonly newKey: () => string;
  /** Against what is due less QR payments still on their way here. */
  readonly entry: PaymentEntry;
  readonly qris: QrisCheckout;
  /** "Bayar nanti" is on, with something still due. */
  readonly unpaid: boolean;
  readonly togglePayLater: () => void;
  readonly unpaidReason: string;
  readonly setUnpaidReason: (reason: string) => void;
  /** Paid in full, nothing due, or let go unpaid with a reason. */
  readonly settled: boolean;
  /** The counter has typed something worth asking about before leaving. */
  readonly touched: boolean;
  /** The money part of `returnDevice`. */
  readonly input: Pick<ReturnDeviceInput, 'payments' | 'unpaidReason'>;
  /** What was entered, as a kept handover holds it (`HandoverDraft`). */
  readonly draft: HandoverPaymentDraft;
}

export interface HandoverPaymentDraft {
  /** The lines as typed; null while the counter has not touched them. */
  readonly lines: readonly PaymentLine[] | null;
  readonly payLater: boolean;
  readonly unpaidReason: string;
}

export interface HandoverQris {
  readonly port: QrisPort | undefined;
  readonly document: MoneyDocument | null;
  /** The payments this device's ledger holds for the servisan, by id; null while they load. */
  readonly recorded: ReadonlySet<string> | null;
  readonly newId: () => string;
}

/**
 * Whether "Bayar nanti" is offered for what is due, and the limit to say beside it: someone holding
 * the permission with a limit (a manager) may leave a debt only up to it, so a larger one is not
 * offered and the limit is said instead. A limit of 0 is the same as not holding it.
 */
export function payLaterOffer(
  held: boolean,
  /** `ModulePort.limitOf(money.extend_credit)`: null when unlimited. */
  limit: number | null,
  due: number,
): {
  readonly offered: boolean;
  readonly limit: number | null;
  readonly overLimit: boolean;
} {
  if (!held || limit === 0) return { offered: false, limit: null, overLimit: false };
  if (limit === null) return { offered: true, limit: null, overLimit: false };
  return due <= limit
    ? { offered: true, limit, overLimit: false }
    : { offered: false, limit, overLimit: true };
}

export function useHandoverPayment(
  due: number,
  accounts: readonly PaymentAccountRow[],
  canPayLater: boolean,
  qrisInput: HandoverQris,
  /** A kept handover's payment, restored as it was entered. */
  restored?: HandoverPaymentDraft | null,
): HandoverPayment {
  // Null until the counter touches the payment: the first line follows what is due as it loads.
  const [typedLines, setLines] = useState<readonly PaymentLine[] | null>(restored?.lines ?? null);
  const [payLater, setPayLater] = useState(restored?.payLater ?? false);
  const [unpaidReason, setUnpaidReason] = useState(restored?.unpaidReason ?? '');
  // New lines are keyed past the restored ones, so no two lines share a key.
  const keys = useRef(restored?.lines?.length ?? 0);
  const qris = useQrisCheckout({
    ...qrisInput,
    lines: typedLines ?? (due > 0 ? [newPaymentLine('line0', due)] : []),
    setLines,
  });
  const { lines } = qris;
  const entry = paymentEntry(due - qris.pending, lines, accounts, qris.qrAccounts);
  const unpaid = canPayLater && payLater && due > 0;
  const waiting = qris.pending > 0;
  return {
    lines,
    setLines,
    newKey: () => `line${String((keys.current += 1))}`,
    entry,
    qris,
    unpaid,
    togglePayLater: () => setPayLater(!unpaid),
    unpaidReason,
    setUnpaidReason,
    settled: !waiting && (due === 0 || (unpaid ? unpaidReason.trim() !== '' : entry.complete)),
    touched: typedLines !== null || unpaidReason.trim() !== '',
    input: {
      payments: unpaid ? [] : [...entry.payments],
      unpaidReason: unpaid ? unpaidReason : null,
    },
    draft: { lines: typedLines, payLater, unpaidReason },
  };
}
