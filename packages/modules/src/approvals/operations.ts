// The `approvals` op registry: payload schemas, reversal notes, appliers and rules. Requests are
// store-scoped: they are asked and answered in the store whose record they are about.
import { z } from 'zod';

import type { OperationDeclaration } from '@bolusi/core';
import { zMoneyIdr, zUuid } from '@bolusi/schemas';

import { answeredApplier, requestedApplier } from './applier.js';
import {
  APPROVAL_ENTITY,
  APPROVAL_OP,
  APPROVAL_PERMISSION,
  MAX_APPROVAL_NOTE,
  MAX_APPROVAL_REASON,
} from './constants.js';
import type { ApprovalKinds } from './kinds.js';
import { createApprovalRules } from './rules.js';
import type { ApprovalsDatabase } from './schema.js';

export const zApprovalReason = z.string().trim().min(1).max(MAX_APPROVAL_REASON);
export const zApprovalNote = z.string().trim().max(MAX_APPROVAL_NOTE).nullable();

export const requestedPayload = z
  .object({
    kind: z.string().min(1).max(60),
    target: z.object({ entityType: z.string().min(1).max(60), entityId: zUuid }).strict(),
    /** The command input approval runs; its kind's schema reads it (rules.ts). */
    input: z.record(z.string(), z.unknown()),
    amount: zMoneyIdr.min(0),
    reason: zApprovalReason,
    basis: z.string().min(1).max(500),
  })
  .strict();

export const answeredPayload = z.object({ note: zApprovalNote }).strict();

export const withdrawnPayload = z.object({}).strict();

export function createApprovalOperations(
  kinds: ApprovalKinds,
): Readonly<Record<string, OperationDeclaration<ApprovalsDatabase>>> {
  const rules = createApprovalRules(kinds);
  const common = { entityType: APPROVAL_ENTITY, permission: APPROVAL_PERMISSION.use } as const;
  return {
    [APPROVAL_OP.requested]: {
      ...common,
      schemaVersion: 1,
      payload: requestedPayload,
      reversal: 'Taken back by the asker with approvals.request_withdrawn while it waits.',
      apply: requestedApplier,
      rule: rules.requestedRule,
    },
    [APPROVAL_OP.approved]: {
      ...common,
      schemaVersion: 1,
      payload: answeredPayload,
      reversal: 'Not reversible: the decision was made and recorded with it.',
      apply: answeredApplier,
      rule: rules.approvedRule,
    },
    [APPROVAL_OP.rejected]: {
      ...common,
      schemaVersion: 1,
      payload: answeredPayload,
      reversal: 'Not reversible: ask again for a new answer.',
      apply: answeredApplier,
      rule: rules.rejectedRule,
    },
    [APPROVAL_OP.withdrawn]: {
      ...common,
      schemaVersion: 1,
      payload: withdrawnPayload,
      reversal: 'Not reversible: ask again.',
      apply: answeredApplier,
      rule: rules.withdrawnRule,
    },
  };
}
