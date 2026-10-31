// The `approvals` module manifest. Built by `createApprovalsModule` from the kinds other modules
// declare, as money is built from document sources; the one list (src/index.ts) hands them in.
import { defineModule, type ModuleDefinition, type ModuleManifest } from '@bolusi/core';

import { approvalRequestsTable } from './applier.js';
import {
  answerRequestInput,
  createApprovalCommands,
  requestApprovalInput,
  withdrawRequestInput,
} from './commands.js';
import { APPROVAL_PERMISSION, APPROVALS_MODULE_ID, APPROVALS_TABLE } from './constants.js';
import type { ApprovalKinds } from './kinds.js';
import { createApprovalOperations } from './operations.js';
import { createApprovalQueries } from './queries.js';
import { APPROVAL_REFUSALS } from './rules.js';
import type { ApprovalsDatabase } from './schema.js';

function approvalsManifest(kinds: ApprovalKinds) {
  const queries = createApprovalQueries(kinds);
  const commands = createApprovalCommands(kinds, queries);
  const use = APPROVAL_PERMISSION.use;
  return {
    id: APPROVALS_MODULE_ID,

    operations: createApprovalOperations(kinds),
    refusals: APPROVAL_REFUSALS.reasons,

    // DDL lives in the client and server migrations, as for money.
    projections: {
      tables: { [APPROVALS_TABLE]: approvalRequestsTable },
    },

    permissions: {
      [use]: {
        scope: 'store',
        isDangerous: false,
        description:
          'Can ask for an approval and answer the requests they may decide. What may be asked and decided is the permission of the decision itself.',
      },
    },

    commands: {
      requestApproval: {
        permission: use,
        input: requestApprovalInput,
        handler: commands.requestApprovalHandler,
      },
      approveRequest: {
        permission: use,
        input: answerRequestInput,
        handler: commands.approveRequestHandler,
      },
      rejectRequest: {
        permission: use,
        input: answerRequestInput,
        handler: commands.rejectRequestHandler,
      },
      withdrawRequest: {
        permission: use,
        input: withdrawRequestInput,
        handler: commands.withdrawRequestHandler,
      },
    },

    queries: {
      approvalRequests: queries.approvalRequestsQuery,
      approvalBasis: queries.approvalBasisQuery,
      approvalRequest: queries.approvalRequestQuery,
    },
  } as const satisfies ModuleManifest<ApprovalsDatabase>;
}

export type ApprovalsModule = ModuleDefinition<
  ApprovalsDatabase,
  ReturnType<typeof approvalsManifest>
>;

export function createApprovalsModule(kinds: ApprovalKinds): ApprovalsModule {
  return defineModule<ApprovalsDatabase, ReturnType<typeof approvalsManifest>>(
    approvalsManifest(kinds),
  );
}
