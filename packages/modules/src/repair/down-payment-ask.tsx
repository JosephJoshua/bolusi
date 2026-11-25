// Whether a down payment fix goes to an owner instead, the same on the phone and the PC. Only an
// owner (or a manager, as far as their refund limit goes) fixes a recorded DP; the counter asks.
// What a fix counts against the limit is what its voids take off, which the approvals module reads
// the same way the rules will (repair approval-kinds.ts), so the step asks exactly when it would
// be refused.
import { MONEY_PERMISSION } from '../money/constants.js';
import type { CorrectDownPaymentInput } from './commands.js';
import { REPAIR_APPROVAL_KIND, REPAIR_PERMISSION } from './constants.js';
import { askedBecauseKey, asksApproval } from './flows.js';
import type { RepairKey } from './i18n.js';
import { useRepairQuery, useRepairRuntime } from './runtime.js';

export interface DownPaymentAsk {
  readonly asking: boolean;
  readonly because: RepairKey;
  /** How much this person may take off a servisan's money, null when not limited. */
  readonly limit: number | null;
  /**
   * What the fix counts against that limit when earlier DP fixes on the servisan count with it
   * (the limit is per servisan, like a discount's), else null: shown so the sum is not a surprise.
   */
  readonly withEarlier: number | null;
}

/**
 * `input` is the fix as typed, null until its amount differs from the recorded one. The reason
 * does not change what is counted, so the limit shows before one is typed.
 */
export function useDownPaymentAsk(
  input: Omit<CorrectDownPaymentInput, 'reason'> | null,
  /** The down payment recorded now. */
  current: number,
): DownPaymentAsk {
  const runtime = useRepairRuntime();
  const holds = runtime.hasPermission(REPAIR_PERMISSION.correctDownPayment);
  const limit = holds ? runtime.limitOf(MONEY_PERMISSION.voidPayment) : null;
  // The query reads a whole fix; a stand-in reason makes the half-typed one parse.
  const asked = holds && limit !== null && input !== null ? { ...input, reason: '-' } : null;
  const takenOff = useRepairQuery(
    async (rt) =>
      asked === null
        ? 0
        : ((
            await rt.approvals.query('approvalBasis', {
              kind: REPAIR_APPROVAL_KIND.downPayment,
              input: asked,
            })
          ).rows[0]?.amount ?? 0),
    `downPaymentAsk:${JSON.stringify(asked)}`,
  );
  const counted = takenOff.status === 'ready' ? takenOff.data : 0;
  return {
    asking: asksApproval(holds, limit, counted),
    because: askedBecauseKey(holds),
    limit,
    withEarlier: asked !== null && counted > Math.max(0, current - asked.amount) ? counted : null,
  };
}
