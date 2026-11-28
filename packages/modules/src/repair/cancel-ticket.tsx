// Cancelling a servisan, the same on the phone and the PC: the store's fee and an owner's change
// to it, what goes back to the customer, and whether a limited role (a manager) asks an owner
// instead. Each app only draws the form.
import { formatMoney } from '@bolusi/i18n';
import { useState } from 'react';

import { ta } from '../approvals/i18n.js';
import { useActionRunner } from '../screen-kit/index.js';

import { REPAIR_APPROVAL_KIND, REPAIR_PERMISSION } from './constants.js';
import { asksApproval, askedBecauseKey, cancelRefund } from './flows.js';
import { tn } from './i18n.js';
import { cancelConsequenceKey } from './labels.js';
import { cancelDrop, cancelRoom, standardCancelFee } from './queries.js';
import { useCancelFees, useRepairRuntime } from './runtime.js';

export interface CancelTicketFacts {
  readonly ticketId: string;
  readonly workStarted: boolean;
  /** The agreed repair price, which the store's fee never goes above. */
  readonly price: number;
  /** The servisan this one is a warranty claim on, if it is one: then it is free to cancel. */
  readonly claimOf: string | null;
  /** Paid in so far: what is above the fee goes back at pickup. */
  readonly downPayment: number;
  /** The discounts standing on the servisan, which a smaller fee counts with against a limit. */
  readonly discounted: number;
}

/**
 * The cancel form. `fee` is the owner's change: undefined while the store's fee applies, null
 * while what was typed is not an amount yet.
 */
export function useCancelTicket(
  facts: CancelTicketFacts,
  form: { readonly fee: number | null | undefined; readonly reason: string },
  done: { readonly onDone: () => void; readonly onAsked: () => void },
) {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [reloadNonce, setReloadNonce] = useState(0);
  const fees = useCancelFees(reloadNonce);
  const { fee, reason } = form;
  const changing = fee !== undefined;
  const standard =
    fees.status === 'ready'
      ? standardCancelFee(
          {
            workStarted: facts.workStarted,
            claimOfTicketId: facts.claimOf,
            quoteTotal: facts.price,
          },
          fees.data,
        )
      : null;
  const charged = changing ? fee : standard;
  const changed = standard !== null && charged !== null && charged !== standard;
  const complete = charged !== null && reason.trim() !== '';
  const holds = runtime.hasPermission(REPAIR_PERMISSION.cancel);
  // A limited role (a manager) sees how far below the store's fee they may go before it is asked.
  const limit = holds ? runtime.limitOf(REPAIR_PERMISSION.cancel) : null;
  const asking = asksApproval(
    holds,
    limit,
    standard === null || charged === null ? 0 : cancelDrop(standard, charged, facts.discounted),
  );
  const refund = cancelRefund(facts.downPayment, charged);

  const submit = (): void => {
    if (!complete || charged === null) return;
    // An unchanged fee is left to the command, which fills in the store's fee as it is then.
    const input = changing
      ? { ticketId: facts.ticketId, reason, fee: charged }
      : { ticketId: facts.ticketId, reason };
    void runner
      .run<unknown>(() =>
        asking
          ? runtime.approvals.run('requestApproval', {
              kind: REPAIR_APPROVAL_KIND.cancel,
              input,
              reason,
            })
          : runtime.run('cancelTicket', input),
      )
      .then((result) => {
        if (result !== undefined) (asking ? done.onAsked : done.onDone)();
      });
  };

  return {
    runner,
    fees,
    retry: () => setReloadNonce((n) => n + 1),
    /** The store's fee, once read. */
    standard,
    /** What the customer is billed: the owner's change, or the store's fee. */
    charged,
    changed,
    complete,
    asking,
    /** How far below the store's fee this person may go before it is asked; null without a limit. */
    room: cancelRoom(limit, standard, facts.discounted),
    title: tn(holds ? 'repair.cancel.title' : 'repair.approval.askCancel'),
    submitLabel: asking ? ta('approvals.action.ask') : tn('repair.action.cancel'),
    /** Nothing is billed and nothing goes back, which the consequence already says. */
    free: charged === 0 && refund === 0,
    /** What cancelling does to the customer's money. */
    consequence:
      refund > 0
        ? tn('repair.cancel.refundsDp', { amount: formatMoney(refund) })
        : tn(cancelConsequenceKey(charged)),
    /** Why it goes to an owner, while it does. */
    askedBecause: asking ? tn(askedBecauseKey(holds)) : null,
    /** Where the fee comes from, under it. */
    feeBasis: changed
      ? tn('repair.cancel.storeFee', { amount: formatMoney(standard) })
      : tn(
          facts.claimOf !== null
            ? 'repair.cancel.claimFree'
            : facts.workStarted
              ? 'repair.cancel.afterWork'
              : 'repair.cancel.beforeWork',
        ),
    /** What is still missing before it can be sent. */
    hint: tn(
      charged === null && (changing || fees.status !== 'loading')
        ? 'repair.hint.cancelFee'
        : 'repair.hint.reason',
    ),
    submit,
  };
}
