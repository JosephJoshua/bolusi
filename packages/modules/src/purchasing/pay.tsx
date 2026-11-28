// Paying a supplier and cancelling a payment, the same on the phone and the PC: the form's state,
// where the money may come from, and the commands. The screens only lay it out.
import { useState } from 'react';

import { useActionRunner, type ActionRunner, type QueryState } from '../screen-kit/index.js';
import type { BillDetailRow } from './bills/queries.js';
import {
  payAboveBalance,
  payAmount,
  payDraftOf,
  payGap,
  payInput,
  type PayDraft,
} from './payments/pay-form.js';
import type { PaymentRow, PaymentSourceRow } from './payments/queries.js';
import type { PurchasingKey } from './i18n.js';
import { usePurchasingQuery, usePurchasingRuntime } from './runtime.js';

export interface PayForm {
  readonly draft: PayDraft;
  readonly setDraft: (draft: PayDraft) => void;
  /** Whether the form holds anything a close would lose. */
  readonly dirty: boolean;
  readonly sources: QueryState<readonly PaymentSourceRow[]>;
  readonly retrySources: () => void;
  /** What still keeps it from being saved. */
  readonly gap: PurchasingKey | null;
  /** The amount typed, or null while there is none. */
  readonly amount: number | null;
  /** More than is left on the bill: the rest becomes the supplier's credit. */
  readonly above: boolean;
  /** Paid by bank transfer, which takes a reference. */
  readonly bank: boolean;
  readonly runner: ActionRunner;
  readonly save: () => void;
}

export function usePayForm(bill: BillDetailRow, onDone: () => void): PayForm {
  const runtime = usePurchasingRuntime();
  const runner = useActionRunner();
  const [from] = useState<PayDraft>(() => payDraftOf(bill));
  const [draft, setDraft] = useState<PayDraft>(from);
  const [nonce, setNonce] = useState(0);
  const sources = usePurchasingQuery(
    async (rt) => (await rt.query('paymentSources', {})).rows,
    `paymentSources:${String(nonce)}`,
  );
  const gap = payGap(draft);
  return {
    draft,
    setDraft,
    dirty: JSON.stringify(draft) !== JSON.stringify(from),
    sources,
    retrySources: () => setNonce((n) => n + 1),
    gap,
    amount: payAmount(draft),
    above: payAboveBalance(draft, bill),
    bank: draft.source.startsWith('account:'),
    runner,
    save: () => {
      if (gap !== null) return;
      void runner
        .run(() => runtime.run('paySupplier', payInput(draft, bill)))
        .then((result) => {
          if (result !== undefined) onDone();
        });
    },
  };
}

export interface VoidPaymentForm {
  readonly reason: string;
  readonly setReason: (reason: string) => void;
  readonly ready: boolean;
  readonly runner: ActionRunner;
  readonly save: () => void;
}

export function useVoidPayment(payment: PaymentRow, onDone: () => void): VoidPaymentForm {
  const runtime = usePurchasingRuntime();
  const runner = useActionRunner();
  const [reason, setReason] = useState('');
  const ready = reason.trim() !== '';
  return {
    reason,
    setReason,
    ready,
    runner,
    save: () => {
      if (!ready) return;
      void runner
        .run(() => runtime.run('voidSupplierPayment', { paymentId: payment.id, reason }))
        .then((result) => {
          if (result !== undefined) onDone();
        });
    },
  };
}
