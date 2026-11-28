// Handing a phone back, the same on the phone and the PC: what is left to pay and how, the
// checklist, whether an owner must do a free handover, and the handover itself once the photo,
// the signature, the payment and the checklist are in. Each app only draws the form.
import type { MediaRef } from '@bolusi/schemas';

import { useChangeCheck } from '../money/change-check.js';
import { useActionRunner } from '../screen-kit/index.js';

import { REPAIR_PERMISSION } from './constants.js';
import { ticketBalance, type HandoverDraft } from './flows.js';
import { useHandoverChecks } from './handover-checks.js';
import { useHandoverPayment } from './handover-payment.js';
import type { TicketDetailRow } from './queries.js';
import { freeHandoverNeedsOwner } from './rules.js';
import { usePaymentAccounts, useRepairRuntime, useTicketQris } from './runtime.js';

/** What the handover reads off the servisan: its bill, what was paid, and what the checks cover. */
export type HandoverTicket = Pick<
  TicketDetailRow,
  | 'outcome'
  | 'peripherals'
  | 'quoteTotal'
  | 'cancelFee'
  | 'reduced'
  | 'downPayment'
  | 'refunds'
  | 'claimOfTicketId'
  | 'ticketNumber'
>;

/**
 * `ticket` is undefined while it loads. `restored` is a kept handover being picked up again, whose
 * payment and ticks come back as they were.
 */
export function useHandoverForm(
  ticketId: string,
  ticket: HandoverTicket | undefined,
  form: {
    readonly photo: MediaRef | null;
    readonly signature: MediaRef | null;
    readonly note: string;
  },
  onDone: () => void,
  restored: HandoverDraft | null = null,
) {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const { photo, signature, note } = form;
  // Until the store's methods load, a method picked earlier would read as cash.
  const loadedAccounts = usePaymentAccounts();
  const accounts = loadedAccounts ?? [];
  const balance =
    ticket === undefined ? { kind: 'due' as const, amount: 0 } : ticketBalance(ticket);
  const due = balance.kind === 'due' ? balance.amount : 0;
  const qris = useTicketQris(ticketId, ticket?.ticketNumber ?? null);
  const payment = useHandoverPayment(ticketId, due, accounts, qris, restored?.payment);
  const checks = useHandoverChecks(ticket, restored?.ticked);
  const ownerNeeded =
    ticket !== undefined &&
    freeHandoverNeedsOwner(ticket) &&
    !runtime.hasPermission(REPAIR_PERMISSION.warrantyException);
  const ready =
    !ownerNeeded &&
    photo !== null &&
    signature !== null &&
    payment.settled &&
    loadedAccounts !== null &&
    checks.ready(note);

  const changeCheck = useChangeCheck();
  const submit = (): void => {
    if (!ready || photo === null || signature === null) return;
    changeCheck.guard(payment.input.payments, () => {
      void runner
        .run(() =>
          runtime.run('returnDevice', {
            ticketId,
            handoverPhoto: photo,
            signature,
            note,
            checklist: [...checks.lines],
            ...payment.input,
          }),
        )
        .then((result) => {
          if (result !== undefined) onDone();
        });
    });
  };

  return {
    runner,
    accounts,
    balance,
    /** What is left to pay now; 0 when nothing is or money goes back. */
    due,
    qris,
    payment,
    checks,
    ownerNeeded,
    ready,
    /** Something was entered that leaving would lose. */
    touched:
      photo !== null ||
      signature !== null ||
      note.trim() !== '' ||
      payment.touched ||
      checks.touched,
    changeCheck,
    submit,
  };
}
