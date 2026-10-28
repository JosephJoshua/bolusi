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
}

/** `input` is the fix as typed, null until it is complete. */
export function useDownPaymentAsk(input: CorrectDownPaymentInput | null): DownPaymentAsk {
  const runtime = useRepairRuntime();
  const holds = runtime.hasPermission(REPAIR_PERMISSION.correctDownPayment);
  const limit = holds ? runtime.limitOf(MONEY_PERMISSION.voidPayment) : null;
  const counted = holds && limit !== null && input !== null ? input : null;
  const takenOff = useRepairQuery(
    async (rt) =>
      counted === null
        ? 0
        : ((
            await rt.approvals.query('approvalBasis', {
              kind: REPAIR_APPROVAL_KIND.downPayment,
              input: counted,
            })
          ).rows[0]?.amount ?? 0),
    `downPaymentAsk:${JSON.stringify(counted)}`,
  );
  return {
    asking: asksApproval(holds, limit, takenOff.status === 'ready' ? takenOff.data : 0),
    because: askedBecauseKey(holds),
    limit,
  };
}
