// What the counter enters to settle a handover, the same on the phone and the PC: the payment
// lines for what is due, or (an owner only) "Bayar nanti" with a reason, which leaves a debt. A
// QRIS line on a method connected to Xendit is paid by its QR (money/qris-hooks.ts); the handover
// then waits for that payment to sync, since the ledger must show the phone paid in full.
import { formatMoney } from '@bolusi/i18n';
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
import { tn } from './i18n.js';

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
  readonly input: Pick<ReturnDeviceInput, 'payments' | 'unpaidReason' | 'refundReason'>;
}

export interface HandoverQris {
  readonly port: QrisPort | undefined;
  readonly document: MoneyDocument | null;
  /** The payments this device's ledger holds for the servisan, by id; null while they load. */
  readonly recorded: ReadonlySet<string> | null;
  readonly newId: () => string;
}

export function useHandoverPayment(
  due: number,
  accounts: readonly PaymentAccountRow[],
  canPayLater: boolean,
  qrisInput: HandoverQris,
): HandoverPayment {
  // Null until the counter touches the payment: the first line follows what is due as it loads.
  const [typedLines, setLines] = useState<readonly PaymentLine[] | null>(null);
  const [payLater, setPayLater] = useState(false);
  const [unpaidReason, setUnpaidReason] = useState('');
  const keys = useRef(0);
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
      refundReason: tn('repair.handover.refundReason'),
    },
  };
}

/** What the counter must hand back before the phone goes (`useHandoverRefunds`), or null. */
export function giveBackText(
  refunds: readonly { readonly label: string; readonly amount: number }[],
): string | null {
  if (refunds.length === 0) return null;
  const parts = refunds.map((refund) =>
    tn('repair.handover.giveBackVia', { amount: formatMoney(refund.amount), method: refund.label }),
  );
  return tn('repair.handover.giveBack', { refunds: parts.join(', ') });
}
