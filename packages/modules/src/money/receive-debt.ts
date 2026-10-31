// A customer paying a debt from the Kas, the same on the phone and the PC: the lines start at the
// whole debt and the counter lowers them for part of it (`debtPayment`). A QRIS line on a method
// connected to Xendit is paid by its QR; the server records that payment, so what is left to record
// here is the other lines, and with none left the step is simply done.
import { useMemo, useRef, useState } from 'react';

import type { NamedBalance } from './kas.js';
import { debtPayment, type DebtPayment } from './kas.js';
import { tm } from './i18n.js';
import { newPaymentLine, type PaymentLine } from './payment-entry.js';
import { pendingQrPayments, useQrisCheckout, type QrisCheckout } from './qris-hooks.js';
import type { PaymentAccountRow } from './queries.js';
import { useMoneyQuery, useMoneyRuntime } from './runtime.js';
import type { ReceivePaymentsInput } from './commands.js';

export interface DebtReceipt extends DebtPayment {
  readonly accounts: readonly PaymentAccountRow[];
  readonly lines: readonly PaymentLine[];
  readonly setLines: (lines: readonly PaymentLine[]) => void;
  readonly newKey: () => string;
  readonly qris: QrisCheckout;
  /** Still owed, as the ledger here says, less QR payments on their way. */
  readonly owed: number;
  /** The counter changed something. */
  readonly dirty: boolean;
  /** Lines to record, all complete. */
  readonly ready: boolean;
  /** Paid by QR with nothing else to record: the step is finished. */
  readonly paidByQr: boolean;
  readonly input: ReceivePaymentsInput | null;
  /** Why it cannot be taken yet, under the button: a QR still unpaid, or the amounts. */
  readonly hint: string | null;
}

export function useDebtReceipt(balance: NamedBalance): DebtReceipt {
  const runtime = useMoneyRuntime();
  const document = useMemo(
    () => ({ kind: balance.documentKind, id: balance.documentId, label: balance.documentLabel }),
    [balance.documentKind, balance.documentId, balance.documentLabel],
  );
  const accounts = useMoneyQuery(
    async (rt) => (await rt.query('paymentAccounts', {})).rows,
    'accounts',
  );
  // Live, so a QR payment that syncs in lowers what is owed.
  const money = useMoneyQuery(
    async (rt) =>
      (await rt.query('documentMoney', { kind: document.kind, id: document.id })).rows[0] ?? null,
    `documentMoney:${document.id}`,
  );
  const ledger = money.status === 'ready' ? money.data : null;
  const recorded = useMemo(
    () => (ledger === null ? null : new Set(ledger.entries.map((entry) => entry.id))),
    [ledger],
  );
  const keys = useRef(0);
  // Null until the counter touches the lines: the first follows what is owed as it loads.
  const [typed, setLines] = useState<readonly PaymentLine[] | null>(null);
  const ledgerBalance = ledger?.balance ?? balance.balance;
  const owed = Math.max(0, ledgerBalance - pendingQrPayments(document.id, recorded));
  const qris = useQrisCheckout({
    port: runtime.qris,
    document,
    lines: typed ?? (owed > 0 ? [newPaymentLine('line0', owed)] : []),
    setLines,
    recorded,
    newId: () => runtime.newId(),
  });
  const accountRows: readonly PaymentAccountRow[] =
    accounts.status === 'ready' ? accounts.data : [];
  const payment = debtPayment(owed, qris.lines, accountRows, qris.qrAccounts);
  const ready = accounts.status === 'ready' && payment.taken !== null && payment.taken.complete;
  const paidByQr = qris.received > 0 && qris.lines.length === 0;
  const input =
    ready && payment.taken !== null ? { document, payments: [...payment.taken.payments] } : null;
  return {
    ...payment,
    accounts: accountRows,
    lines: qris.lines,
    setLines,
    newKey: () => `line${String((keys.current += 1))}`,
    qris,
    owed,
    dirty: typed !== null,
    ready,
    paidByQr,
    input,
    hint:
      // Too much is said once, under the payment.
      paidByQr || input !== null || payment.entry.overpaid > 0
        ? null
        : Object.values(payment.entry.problems).includes('qr')
          ? tm('money.receive.waitQr')
          : tm('money.receive.hint'),
  };
}
