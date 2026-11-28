// A new price line after intake, the same on the phone and the PC. The cashier changes the price
// directly, answering whether the customer agreed as the save itself; a technician only proposes
// it for the cashier to decide. A discount the cashier may not give (or not that large) goes to an
// owner instead, and asks the customer once it is approved. Each app only draws the form.
import { useMemo } from 'react';

import { ta } from '../approvals/i18n.js';
import { useActionRunner } from '../screen-kit/index.js';

import { REPAIR_APPROVAL_KIND, REPAIR_PERMISSION } from './constants.js';
import {
  askedBecauseKey,
  asksApproval,
  priceKinds,
  signedAmount,
  type PriceKind,
} from './flows.js';
import { tn } from './i18n.js';
import { discountLimitHint } from './labels.js';
import { useRepairRuntime } from './runtime.js';

/** The kinds of line this person may add; a discount too where one may be asked of an owner. */
export function usePriceKinds(askable = false): readonly PriceKind[] {
  const runtime = useRepairRuntime();
  const discount = askable || runtime.hasPermission(REPAIR_PERMISSION.discount);
  return useMemo(() => priceKinds(discount), [discount]);
}

export interface PriceChangeFacts {
  readonly ticketId: string;
  readonly mode: 'change' | 'propose';
  /** What the discounts already on the servisan take off; a limit counts them too. */
  readonly discounted: number;
}

/**
 * `onAsked` is set where a discount may be asked of an owner (changing the price, not proposing
 * it). `amount` is the line as typed, unsigned, null while it is not an amount yet.
 */
export function usePriceChange(
  facts: PriceChangeFacts,
  form: {
    readonly kind: PriceKind;
    readonly description: string;
    readonly amount: number | null;
    readonly reason: string;
  },
  done: { readonly onDone: () => void; readonly onAsked?: (() => void) | undefined },
) {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const { ticketId, mode, discounted } = facts;
  const { kind, description, amount, reason } = form;
  const kinds = usePriceKinds(done.onAsked !== undefined);
  const holdsDiscount = runtime.hasPermission(REPAIR_PERMISSION.discount);
  // A limited role (a manager) sees how far they may discount before it goes to an owner.
  const discountLimit = runtime.limitOf(REPAIR_PERMISSION.discount);
  const complete = description.trim() !== '' && amount !== null && reason.trim() !== '';
  const asking =
    done.onAsked !== undefined &&
    kind === 'discount' &&
    asksApproval(holdsDiscount, discountLimit, discounted + (amount ?? 0));

  const submit = (customerAgreed: boolean): void => {
    if (!complete || amount === null) return;
    const line = { ticketId, kind, description, amount: signedAmount(kind, amount), reason };
    void runner
      .run<unknown>(() =>
        asking
          ? runtime.approvals.run('requestApproval', {
              kind: REPAIR_APPROVAL_KIND.discount,
              input: { ...line, customerAgreed: false },
              reason,
            })
          : mode === 'change'
            ? runtime.run('changeQuote', { ...line, customerAgreed })
            : runtime.run('proposeQuoteChange', line),
      )
      .then((result) => {
        if (result !== undefined) (asking ? (done.onAsked ?? done.onDone) : done.onDone)();
      });
  };

  return {
    runner,
    kinds,
    complete,
    asking,
    /** The save is the customer's answer: agreed, or applied before they answer. Asking skips it. */
    deciding: mode === 'change' && !asking,
    title: tn(mode === 'change' ? 'repair.price.editTitle' : 'repair.action.proposePrice'),
    /** The save's label where it is not the customer's answer. */
    sendLabel: asking ? ta('approvals.action.ask') : tn('repair.action.proposePrice'),
    /** How far this person may still discount, under a discount, while they are limited. */
    limitLine:
      kind !== 'discount' || !holdsDiscount || discountLimit === null
        ? null
        : discountLimitHint(discountLimit, discounted),
    /** Why it goes to an owner, while it does. */
    askedBecause: asking ? tn(askedBecauseKey(holdsDiscount)) : null,
    submit,
  };
}

/** The counter decides a waiting price change with the customer's answer as the choice itself. */
export function useDecideProposal(
  facts: {
    readonly ticketId: string;
    readonly line: { readonly id: string; readonly amount: number };
  },
  note: string,
  onDone: () => void,
) {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const { ticketId, line } = facts;
  const decide = (decision: 'agreed' | 'declined'): void => {
    void runner
      .run(() =>
        decision === 'declined'
          ? runtime.run('declineProposal', { ticketId, lineId: line.id, note })
          : runtime.run('applyProposal', { ticketId, lineId: line.id, customerAgreed: true, note }),
      )
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };
  return {
    runner,
    // A line that lowers the price is an owner's to apply; anyone deciding may still decline it.
    mayApply: line.amount >= 0 || runtime.hasPermission(REPAIR_PERMISSION.discount),
    decide,
  };
}
