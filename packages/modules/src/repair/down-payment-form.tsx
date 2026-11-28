// Recording a down payment after intake, or (owners) changing one already recorded, the same on
// the phone and the PC: what the typed amount means, which method it went through, what is still
// missing, and whether a fix goes to an owner instead. Each app only draws the form.
import { formatMoney } from '@bolusi/i18n';

import { ta } from '../approvals/i18n.js';
import { accountLabel } from '../money/kas.js';
import {
  chosenMethod,
  methodMissing,
  offeredAccount,
  referenceMissing,
} from '../money/payment-entry.js';
import { useActionRunner } from '../screen-kit/index.js';

import { REPAIR_APPROVAL_KIND, REPAIR_PERMISSION } from './constants.js';
import { useDownPaymentAsk } from './down-payment-ask.js';
import { downPaymentEntry } from './flows.js';
import { tn } from './i18n.js';
import { DOWN_PAYMENT_GAP_KEY, downPaymentChangeLine, downPaymentTitleKey } from './labels.js';
import { useDownPaymentMethod, usePaymentAccounts, useRepairRuntime } from './runtime.js';

export interface DownPaymentFacts {
  readonly ticketId: string;
  readonly mode: 'record' | 'correct';
  /** The down payment recorded now; null when none is. */
  readonly current: number | null;
  /** What the customer owes, which a down payment never goes above. */
  readonly total: number;
}

/** `typed` is the amount as typed, null while it is not one yet. */
export function useDownPaymentForm(
  facts: DownPaymentFacts,
  form: { readonly typed: number | null; readonly reason: string },
  done: { readonly onDone: () => void; readonly onAsked: () => void },
) {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const { ticketId, mode, current, total } = facts;
  const { typed, reason } = form;
  const [method, setMethod] = useDownPaymentMethod(ticketId, mode);
  // Until the store's methods load, a method picked earlier would read as cash.
  const loadedAccounts = usePaymentAccounts();
  const accounts = loadedAccounts ?? [];
  const correcting = mode === 'correct';
  const { amount, aboveTotal, gap } = downPaymentEntry({
    mode,
    typed,
    reason,
    current,
    total,
    methodMissing: methodMissing(method.account, accounts),
    referenceMissing: referenceMissing(method.account, method.reference, accounts),
  });
  const complete = gap === null && loadedAccounts !== null;
  const through = chosenMethod(method.account, method.reference, accounts);
  const fix =
    correcting && complete && amount !== null ? { ticketId, amount, reason, ...through } : null;
  // Whether it goes to an owner shows as soon as the new amount is typed, before the reason.
  const typedFix =
    correcting && amount !== null && amount !== current && !aboveTotal && loadedAccounts !== null
      ? { ticketId, amount, ...through }
      : null;
  const ask = useDownPaymentAsk(typedFix, current ?? 0);
  const asking = correcting && ask.asking;

  const submit = (): void => {
    if (!complete || amount === null) return;
    void runner
      .run<unknown>(() =>
        fix === null
          ? runtime.run('recordDownPayment', { ticketId, amount, ...through })
          : asking
            ? runtime.approvals.run('requestApproval', {
                kind: REPAIR_APPROVAL_KIND.downPayment,
                input: fix,
                reason,
              })
            : runtime.run('correctDownPayment', fix),
      )
      .then((result) => {
        if (result !== undefined) (asking ? done.onAsked : done.onDone)();
      });
  };

  return {
    runner,
    method,
    setMethod,
    accounts,
    correcting,
    aboveTotal,
    /** What is still missing, null once it can be saved. */
    gap,
    complete,
    asking,
    /** The method is asked for unless a fix takes the down payment away. */
    asksMethod: !correcting || (amount ?? 0) !== 0,
    title: tn(
      downPaymentTitleKey(mode, runtime.hasPermission(REPAIR_PERMISSION.correctDownPayment)),
    ),
    submitLabel: asking ? ta('approvals.action.ask') : tn('repair.downPayment.save'),
    gapHint: gap === null ? null : tn(DOWN_PAYMENT_GAP_KEY[gap]),
    /** What a fix changes, through which method, once one is picked. */
    changeLine:
      !correcting || methodMissing(method.account, accounts)
        ? null
        : downPaymentChangeLine(
            current,
            amount,
            accountLabel(offeredAccount(method.account, accounts), accounts),
          ),
    limitLine:
      !correcting || ask.limit === null
        ? null
        : tn('repair.hint.downPaymentLimit', { amount: formatMoney(ask.limit) }),
    withEarlierLine:
      ask.withEarlier === null
        ? null
        : tn('repair.hint.downPaymentWithEarlier', { amount: formatMoney(ask.withEarlier) }),
    askedBecause: asking ? tn(ask.because) : null,
    submit,
  };
}
