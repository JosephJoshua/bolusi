// Whether "Ubah biaya" on a cancelled servisan goes to an owner instead, the same on the phone and
// the PC. A limited role (a manager) lowers what the customer is billed only within its limit, as
// the change's own rules count it (commands.ts changeCancelFeeHandler): before anything is charged
// the fee itself comes down, counted from the store's fee with the discounts against the cancel
// limit; once charged the bill is cut, counted against the refund limit as Kurangi tagihan is.
// Beyond it the same change is asked for, with the fee as typed (one kind before a charge, one
// after, for the two limits), so the owner reads that fee and their yes records exactly what the
// manager would have.
import { formatMoney } from '@bolusi/i18n';

import { APPROVAL_PERMISSION } from '../approvals/constants.js';
import { ta } from '../approvals/i18n.js';
import { MONEY_PERMISSION } from '../money/constants.js';
import { REPAIR_APPROVAL_KIND, REPAIR_PERMISSION } from './constants.js';
import { askedBecauseKey, discountsStanding } from './flows.js';
import { tn } from './i18n.js';
import { REPAIR_DOCUMENT_KIND } from './money-document.js';
import { cancelDrop, standardCancelFee, type TicketDetailRow } from './queries.js';
import { useActionRunner } from '../screen-kit/index.js';
import { useCancelFees, useRepairQuery, useRepairRuntime } from './runtime.js';

export type CancelFeeTicket = Pick<
  TicketDetailRow,
  'id' | 'workStarted' | 'claimOfTicketId' | 'quoteLines' | 'quoteTotal'
>;

/** Where a fee change stands against a limit, from what the servisan's money says now. */
export interface CancelFeeMoney {
  /** What was charged for the servisan; 0 while nothing is. */
  readonly charged: number;
  /** What was taken off the charge already. */
  readonly reduced: number;
}

/** The approval request the change becomes, without its reason. */
export interface CancelFeeRequest {
  readonly kind: string;
  readonly input: Record<string, unknown>;
}

/**
 * The request a limited role sends instead of changing the fee to `fee`, or null when the change
 * is theirs to make. `cancelLimit` and `refundLimit` are the person's limits (null: not limited),
 * `standard` the store's fee for this servisan now.
 */
export function cancelFeeRequest(
  ticket: CancelFeeTicket,
  money: CancelFeeMoney,
  current: number,
  fee: number,
  limits: { readonly cancel: number | null; readonly refund: number | null },
  standard: number,
): CancelFeeRequest | null {
  if (fee >= current) return null;
  if (money.charged === 0) {
    const counted = cancelDrop(standard, fee, discountsStanding(ticket.quoteLines));
    return limits.cancel !== null && counted > limits.cancel
      ? { kind: REPAIR_APPROVAL_KIND.cancelFee, input: { ticketId: ticket.id, fee } }
      : null;
  }
  const cut = current - fee;
  return limits.refund !== null && money.reduced + cut > limits.refund
    ? { kind: REPAIR_APPROVAL_KIND.cancelFeeCharged, input: { ticketId: ticket.id, fee } }
    : null;
}

export interface CancelFeeAsk {
  /** Saving asks an owner instead (`request`). */
  readonly asking: boolean;
  /** What saving asks for, with the reason typed. */
  readonly request: (reason: string) => CancelFeeRequest & { readonly reason: string };
}

/** `current` is what the customer is billed now; `fee` the bill as typed, null while unreadable. */
export function useCancelFeeAsk(
  ticket: CancelFeeTicket,
  current: number,
  fee: number | null,
): CancelFeeAsk {
  const runtime = useRepairRuntime();
  const limited =
    runtime.approvals.hasPermission(APPROVAL_PERMISSION.use) &&
    (runtime.limitOf(REPAIR_PERMISSION.cancel) !== null ||
      runtime.limitOf(MONEY_PERMISSION.refund) !== null);
  // Live, so a charge or cut that syncs in while the step is open moves the answer with it.
  const money = useRepairQuery(
    async (rt) =>
      limited
        ? ((await rt.money.query('documentMoney', { kind: REPAIR_DOCUMENT_KIND, id: ticket.id }))
            .rows[0] ?? null)
        : null,
    `cancelFeeMoney:${ticket.id}:${String(limited)}`,
  );
  const fees = useCancelFees();
  const request =
    !limited || fee === null || money.status !== 'ready' || money.data === null
      ? null
      : cancelFeeRequest(
          ticket,
          money.data,
          current,
          fee,
          {
            cancel: runtime.limitOf(REPAIR_PERMISSION.cancel),
            refund: runtime.limitOf(MONEY_PERMISSION.refund),
          },
          fees.status === 'ready' ? standardCancelFee(ticket, fees.data) : 0,
        );
  return {
    asking: request !== null,
    request: (reason) => {
      if (request === null) throw new Error('nothing to ask');
      return { ...request, input: { ...request.input, reason }, reason };
    },
  };
}

/**
 * The "Ubah biaya" form on a cancelled servisan. `fee` is the bill as typed (null while it is not
 * an amount yet), `current` the bill now and `paid` what was paid in so far.
 */
export function useChangeCancelFee(
  facts: { readonly ticket: CancelFeeTicket; readonly current: number; readonly paid: number },
  form: { readonly fee: number | null; readonly reason: string },
  done: { readonly onDone: () => void; readonly onAsked: () => void },
) {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const { ticket, current, paid } = facts;
  const { fee, reason } = form;
  const changed = fee !== null && fee !== current;
  const complete = changed && reason.trim() !== '';
  const ask = useCancelFeeAsk(ticket, current, changed ? fee : null);
  const submit = (): void => {
    if (fee === null || !complete) return;
    const asking = ask.asking;
    void runner
      .run<unknown>(() =>
        asking
          ? runtime.approvals.run('requestApproval', ask.request(reason.trim()))
          : runtime.run('changeCancelFee', { ticketId: ticket.id, fee, reason }),
      )
      .then((result) => {
        if (result !== undefined) (asking ? done.onAsked : done.onDone)();
      });
  };
  return {
    runner,
    changed,
    complete,
    /** Something was typed that leaving would lose. */
    dirty: changed || reason.trim() !== '',
    asking: ask.asking,
    submitLabel: ask.asking ? ta('approvals.action.ask') : tn('repair.cancelFee.save'),
    /** What the bill is now and what was paid against it. */
    explain:
      paid > 0
        ? tn('repair.cancelFee.paid', { bill: formatMoney(current), amount: formatMoney(paid) })
        : tn('repair.cancelFee.unpaid', { bill: formatMoney(current) }),
    /** Why it goes to an owner, while it does. */
    askedBecause: ask.asking ? tn(askedBecauseKey(true)) : null,
    /** What is still missing before it can be saved. */
    hint: tn(
      fee === null
        ? 'repair.hint.cancelFee'
        : changed
          ? 'repair.hint.reason'
          : 'repair.cancelFee.same',
    ),
    submit,
  };
}
