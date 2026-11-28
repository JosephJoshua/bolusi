// Kasbon above a Manajer's store limit (approvals/kinds.ts): the Manajer asks from the kasbon form,
// an owner approves, and approving gives the kasbon as the owner, so its rules hold the owner to
// their own limit (none). The request is about the employee, so it waits with their pay.
import type { Kysely } from 'kysely';

import { approvalKind, type ApprovalKinds } from '../approvals/kinds.js';
import { advanceBalance } from './advances.js';
import { giveAdvanceHandler, giveAdvanceInput } from './commands.js';
import { PAY_APPROVAL_KIND, PAY_EMPLOYEE_ENTITY, PAY_PERMISSION } from './constants.js';
import type { PayDatabase } from './schema.js';

export const payApprovalKinds: ApprovalKinds = {
  [PAY_APPROVAL_KIND.advance]: approvalKind({
    id: PAY_APPROVAL_KIND.advance,
    input: giveAdvanceInput,
    handler: giveAdvanceHandler,
    commandPermission: PAY_PERMISSION.advances,
    permission: PAY_PERMISSION.advances,
    askPermission: PAY_PERMISSION.advances,
    fits: () => true,
    target: (input) => ({ entityType: PAY_EMPLOYEE_ENTITY, entityId: input.userId }),
    amount: (_db, _scope, input) => Promise.resolve(input.amount),
    // A kasbon given or paid back since changes what the owner would be approving on top of.
    basis: async (db, scope, input) => {
      const { balance } = await advanceBalance(
        db as unknown as Kysely<PayDatabase>,
        scope,
        input.userId,
      );
      return `${input.userId}|${balance}`;
    },
  }),
};
