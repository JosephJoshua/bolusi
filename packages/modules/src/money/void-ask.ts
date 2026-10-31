// Whether cancelling a payment goes to an owner instead, the same on the phone and the PC. Only an
// owner (or a manager, as far as their refund limit goes) cancels a payment; whoever takes payments
// asks. What a cancel counts against the limit is read from the ledger the way its rule counts it
// (`voidCounted`, with what was already taken off the servisan), so the screen asks exactly when
// saving would be refused.
import { APPROVAL_PERMISSION } from '../approvals/constants.js';
import { MONEY_APPROVAL_KIND, MONEY_PERMISSION } from './constants.js';
import type { MoneyKey } from './i18n.js';
import { voidKind } from './kas.js';
import type { MoneyEntryRow } from './queries.js';
import { useMoneyQuery, useMoneyRuntime, type MoneyRuntime } from './runtime.js';

export interface VoidAsk {
  /** Cancelling it here would be refused, so the step asks an owner instead. */
  readonly asking: boolean;
  /** Asking is open to this person for this record (a payment on a servisan). */
  readonly mayAsk: boolean;
  /** The count against a limit is still being read (or failed): neither save nor ask yet. */
  readonly pending: boolean;
  readonly because: MoneyKey;
  /** How much this person may take off a servisan's money, null when not limited. */
  readonly limit: number | null;
  /** What this cancel counts against that limit, with what was already taken off. */
  readonly counted: number;
  /** That count when earlier reductions on the servisan add to it, else null: said up front. */
  readonly withEarlier: number | null;
}

export function useVoidAsk(entry: MoneyEntryRow): VoidAsk {
  const runtime = useMoneyRuntime();
  const payment = voidKind(entry).command === 'voidPayment';
  const holds = runtime.hasPermission(MONEY_PERMISSION.voidPayment);
  const limit = payment && holds ? runtime.limitOf(MONEY_PERMISSION.voidPayment) : null;
  const count = useMoneyQuery(
    async (rt) =>
      limit === null
        ? entry.amount
        : ((await rt.query('voidCount', { entryId: entry.id })).rows[0]?.counted ?? entry.amount),
    `voidCount:${entry.id}:${limit ?? ''}`,
  );
  const counted = count.status === 'ready' ? count.data : entry.amount;
  return {
    pending: limit !== null && count.status !== 'ready',
    asking: payment && (!holds || (limit !== null && counted > limit)),
    mayAsk: payment && mayAskVoid(runtime, entry),
    because: holds ? 'money.void.overLimit' : 'money.void.needsApproval',
    limit,
    counted,
    withEarlier: limit !== null && counted > entry.amount ? counted : null,
  };
}

function mayAskVoid(runtime: MoneyRuntime, entry: MoneyEntryRow): boolean {
  return (
    entry.documentKind !== null &&
    entry.documentId !== null &&
    runtime.approvals.hasPermission(APPROVAL_PERMISSION.use) &&
    (runtime.hasPermission(MONEY_PERMISSION.receive) ||
      runtime.hasPermission(MONEY_PERMISSION.voidPayment))
  );
}

/** The approval request a cancel asks for: the void itself, about the payment's servisan. */
export function voidRequest(entry: MoneyEntryRow, reason: string) {
  return {
    kind: MONEY_APPROVAL_KIND.voidPayment,
    input: {
      entryId: entry.id,
      reason,
      document: { kind: entry.documentKind ?? '', id: entry.documentId ?? '' },
    },
    reason,
  };
}
