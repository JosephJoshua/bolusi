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
import { tn } from './i18n.js';

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
  readonly input: Pick<ReturnDeviceInput, 'payments' | 'unpaidReason' | 'refundReason'>;
}

export function useHandoverPayment(
  due: number,
  accounts: readonly PaymentAccountRow[],
  canPayLater: boolean,
): HandoverPayment {
  // Null until the counter touches the payment: the first line follows what is due as it loads.
  const [typedLines, setLines] = useState<readonly PaymentLine[] | null>(null);
  const [payLater, setPayLater] = useState(false);
  const [unpaidReason, setUnpaidReason] = useState('');
  const keys = useRef(0);
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
      refundReason: tn('repair.handover.refundReason'),
    },
  };
}
