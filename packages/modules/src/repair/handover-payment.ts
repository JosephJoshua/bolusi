// What the counter enters to settle a handover, the same on the phone and the PC: the payment
// lines for what is due, or "Bayar nanti" with a reason, which leaves a debt. Bayar nanti is an
// owner's decision (a manager's within their limit); anyone else asks for it, and an approval lets
// the counter use it at this handover. A QRIS line on a method connected to Xendit is paid by its
// QR (money/qris-hooks.ts); the handover then waits for that payment to sync, since the ledger
// must show the phone paid in full.
import { formatMoney } from '@bolusi/i18n';
import { useRef, useState } from 'react';

import { APPROVAL_PERMISSION } from '../approvals/constants.js';
import { MONEY_PERMISSION } from '../money/constants.js';
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
import { REPAIR_APPROVAL_KIND } from './constants.js';
import { payLaterAccess, type PayLaterAccess } from './flows.js';
import { readApprovals, useRepairQuery, useRepairRuntime } from './runtime.js';
import { tn, type RepairKey } from './i18n.js';

export interface HandoverPayment {
  readonly lines: readonly PaymentLine[];
  readonly setLines: (lines: readonly PaymentLine[]) => void;
  readonly newKey: () => string;
  /** Against what is due less QR payments still on their way here. */
  readonly entry: PaymentEntry;
  readonly qris: QrisCheckout;
  /** "Bayar nanti" is on, with something still due. */
  readonly unpaid: boolean;
  /** Whether this person may leave it unpaid, or where asking stands. */
  readonly access: PayLaterAccess;
  /** This person's Bayar nanti limit, null when they have none. */
  readonly limit: number | null;
  readonly togglePayLater: () => void;
  readonly unpaidReason: string;
  readonly setUnpaidReason: (reason: string) => void;
  /** Paid in full, nothing due, or let go unpaid with a reason. */
  readonly settled: boolean;
  /** The counter has typed something worth asking about before leaving. */
  readonly touched: boolean;
  /** The money part of `returnDevice`. */
  readonly input: Pick<ReturnDeviceInput, 'payments' | 'unpaidReason' | 'refundReason'>;
  /** Asks an owner to let the phone go unpaid, with the reason typed. */
  readonly askPayLater: () => Promise<unknown>;
}

/** Whether this person may let the phone go unpaid, read live so an approval shows as it lands. */
function usePayLaterAccess(ticketId: string, due: number, limit: number | null): PayLaterAccess {
  const runtime = useRepairRuntime();
  const requests = useRepairQuery(
    async (rt) =>
      (await readApprovals(rt, ticketId)).filter(
        (row) => row.kind === REPAIR_APPROVAL_KIND.payLater,
      ),
    `payLater:${ticketId}`,
  );
  return payLaterAccess({
    holds: runtime.hasPermission(MONEY_PERMISSION.extendCredit),
    limit,
    canAsk: runtime.approvals.hasPermission(APPROVAL_PERMISSION.use),
    due,
    requests: requests.status === 'ready' ? requests.data : [],
  });
}

export interface HandoverQris {
  readonly port: QrisPort | undefined;
  readonly document: MoneyDocument | null;
  /** The payments this device's ledger holds for the servisan, by id; null while they load. */
  readonly recorded: ReadonlySet<string> | null;
  readonly newId: () => string;
}

export function useHandoverPayment(
  ticketId: string,
  due: number,
  accounts: readonly PaymentAccountRow[],
  qrisInput: HandoverQris,
): HandoverPayment {
  const runtime = useRepairRuntime();
  // Someone who cannot do it at all has no limit to show (`limitOf` reads it as 0).
  const limit = runtime.hasPermission(MONEY_PERMISSION.extendCredit)
    ? runtime.limitOf(MONEY_PERMISSION.extendCredit)
    : null;
  const access = usePayLaterAccess(ticketId, due, limit);
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
  const unpaid = access.kind !== 'none' && payLater && due > 0;
  const allowed = access.kind === 'own' || access.kind === 'permitted';
  const waiting = qris.pending > 0;
  return {
    lines,
    setLines,
    newKey: () => `line${String((keys.current += 1))}`,
    entry,
    qris,
    unpaid,
    access,
    limit,
    togglePayLater: () => setPayLater(!unpaid),
    unpaidReason,
    setUnpaidReason,
    settled:
      !waiting && (due === 0 || (unpaid ? allowed && unpaidReason.trim() !== '' : entry.complete)),
    touched: typedLines !== null || unpaidReason.trim() !== '',
    input: {
      payments: unpaid ? [] : [...entry.payments],
      unpaidReason: unpaid ? unpaidReason : null,
      refundReason: tn('repair.handover.refundReason'),
    },
    askPayLater: () =>
      runtime.approvals.run('requestApproval', {
        kind: REPAIR_APPROVAL_KIND.payLater,
        input: { ticketId },
        reason: unpaidReason.trim(),
      }),
  };
}

/** What the Bayar nanti part says under the reason, line by line, the same on the phone and PC. */
export function payLaterLines(
  payment: Pick<HandoverPayment, 'access' | 'limit'>,
  due: number,
): readonly { readonly id: string; readonly text: string }[] {
  const { access, limit } = payment;
  const debt = {
    id: 'debt',
    text: tn('repair.handover.payLaterNote', { amount: formatMoney(due) }),
  };
  // A limited person sees their limit before they find it out from a refusal.
  const limitLine =
    limit === null
      ? []
      : [
          {
            id: 'limit',
            text: tn('repair.handover.payLaterLimit', { amount: formatMoney(limit) }),
          },
        ];
  switch (access.kind) {
    case 'own':
      return [debt, ...limitLine];
    case 'permitted':
      return [
        {
          id: 'permitted',
          text: tn('repair.handover.payLaterPermitted', { name: access.by ?? '' }),
        },
        debt,
      ];
    case 'waiting':
      return [{ id: 'waiting', text: tn('repair.handover.payLaterWaiting') }];
    case 'ask': {
      const { rejected } = access;
      const name = rejected?.decidedByName ?? '';
      return [
        ...(rejected === null
          ? []
          : [
              {
                id: 'rejected',
                text:
                  rejected.note === null
                    ? tn('repair.handover.payLaterRejected', { name })
                    : tn('repair.handover.payLaterRejectedNote', { name, note: rejected.note }),
              },
            ]),
        { id: 'asks', text: tn(access.because) },
        ...limitLine,
      ];
    }
    case 'none':
      return [];
  }
}

/** What the handover still waits on when the payment is not settled. */
export function payLaterHintKey(payment: Pick<HandoverPayment, 'access' | 'unpaid'>): RepairKey {
  if (!payment.unpaid) return 'repair.hint.handoverPayment';
  if (payment.access.kind === 'waiting') return 'repair.hint.payLaterWaiting';
  if (payment.access.kind === 'ask') return 'repair.hint.payLaterAsk';
  // Theirs to do, or approved: only the reason is missing.
  return 'repair.hint.reason';
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
