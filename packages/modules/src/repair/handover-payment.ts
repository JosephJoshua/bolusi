// What the counter enters to settle a handover, the same on the phone and the PC: the payment
// lines for what is due, or (an owner only) "Bayar nanti" with a reason, which leaves a debt.
import { useRef, useState } from 'react';

import {
  newPaymentLine,
  paymentEntry,
  type PaymentEntry,
  type PaymentLine,
} from '../money/payment-entry.js';
import type { PaymentAccountRow } from '../money/queries.js';
import type { ReturnDeviceInput } from './commands.js';

export interface HandoverPayment {
  readonly lines: readonly PaymentLine[];
  readonly setLines: (lines: readonly PaymentLine[]) => void;
  readonly newKey: () => string;
  readonly entry: PaymentEntry;
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

export function useHandoverPayment(
  due: number,
  accounts: readonly PaymentAccountRow[],
  canPayLater: boolean,
  /** A kept handover's payment, restored as it was entered. */
  restored?: HandoverPaymentDraft | null,
): HandoverPayment {
  // Null until the counter touches the payment: the first line follows what is due as it loads.
  const [typedLines, setLines] = useState<readonly PaymentLine[] | null>(restored?.lines ?? null);
  const [payLater, setPayLater] = useState(restored?.payLater ?? false);
  const [unpaidReason, setUnpaidReason] = useState(restored?.unpaidReason ?? '');
  // New lines are keyed past the restored ones, so no two lines share a key.
  const keys = useRef(restored?.lines?.length ?? 0);
  const lines = typedLines ?? (due > 0 ? [newPaymentLine('line0', due)] : []);
  const entry = paymentEntry(due, lines, accounts);
  const unpaid = canPayLater && payLater && due > 0;
  return {
    lines,
    setLines,
    newKey: () => `line${String((keys.current += 1))}`,
    entry,
    unpaid,
    togglePayLater: () => setPayLater(!unpaid),
    unpaidReason,
    setUnpaidReason,
    settled: due === 0 || (unpaid ? unpaidReason.trim() !== '' : entry.complete),
    touched: typedLines !== null || unpaidReason.trim() !== '',
    input: {
      payments: unpaid ? [] : [...entry.payments],
      unpaidReason: unpaid ? unpaidReason : null,
    },
    draft: { lines: typedLines, payLater, unpaidReason },
  };
}
