// The `approvals` commands: ask, approve (which makes the decision too), reject, withdraw. Each is a
// pure handler (04 §5): reads through the query layer, returns op drafts. Whether the person may
// ask or answer is the op rules' (rules.ts), which run on every op a command produces.
import { z } from 'zod';

import { DomainError, type CommandContext, type CommandHandlerResult } from '@bolusi/core';
import { zUuid } from '@bolusi/schemas';

import { APPROVAL_ENTITY, APPROVAL_OP } from './constants.js';
import type { ApprovalKinds } from './kinds.js';
import { APPROVAL_REFUSALS } from './rules.js';
import { zApprovalNote, zApprovalReason } from './operations.js';
import type { createApprovalQueries } from './queries.js';

type Queries = ReturnType<typeof createApprovalQueries>;
type OpDraft = ReturnType<CommandContext['op']>;

export const requestApprovalInput = z
  .object({
    kind: z.string().min(1).max(60),
    /** The input of the command approval runs (a price line, a cancel with its fee). */
    input: z.record(z.string(), z.unknown()),
    reason: zApprovalReason,
  })
  .strict();

export const answerRequestInput = z
  .object({ requestId: zUuid, note: zApprovalNote.default(null) })
  .strict();

export const withdrawRequestInput = z.object({ requestId: zUuid }).strict();

export function createApprovalCommands(kinds: ApprovalKinds, queries: Queries) {
  const kindOf = (id: string) => {
    const kind = kinds[id];
    if (kind === undefined) {
      throw new DomainError('VALIDATION_FAILED', {
        field: 'kind',
        issue: `no approval kind ${id}`,
      });
    }
    return kind;
  };

  async function requestApprovalHandler(
    input: z.output<typeof requestApprovalInput>,
    ctx: CommandContext,
  ): Promise<CommandHandlerResult<{ requestId: string }>> {
    const kind = kindOf(input.kind);
    const parsed = kind.input.safeParse(input.input);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_FAILED', {
        field: 'input',
        issue: parsed.error.issues[0]?.message ?? 'invalid',
      });
    }
    const asked = (
      await ctx.query(queries.approvalBasisQuery, { kind: kind.id, input: input.input })
    ).rows[0];
    if (asked === null || asked === undefined) {
      const target = kind.target(parsed.data as never);
      throw new DomainError('ENTITY_NOT_FOUND', { ...target });
    }
    const requestId = ctx.newId();
    return {
      ops: [
        ctx.op({
          type: APPROVAL_OP.requested,
          entityType: APPROVAL_ENTITY,
          entityId: requestId,
          payload: {
            kind: kind.id,
            target: kind.target(parsed.data as never),
            // What the kind read, so approval runs exactly what was asked.
            input: parsed.data as Record<string, unknown>,
            amount: asked.amount,
            reason: input.reason,
            basis: asked.basis,
          },
        }),
      ],
      result: { requestId },
    };
  }

  /**
   * The decision's context: its first new id is the request's own, so the record it makes (a price
   * line) is the same whoever approves. A second approval made offline elsewhere then makes the same
   * record again, which its own rules refuse (a line that exists), instead of a second discount.
   */
  function decidingOnce(ctx: CommandContext, requestId: string): CommandContext {
    let first = true;
    return {
      ...ctx,
      newId: () => {
        if (!first) return ctx.newId();
        first = false;
        return requestId;
      },
    };
  }

  async function waiting(ctx: CommandContext, requestId: string) {
    const request = (await ctx.query(queries.approvalRequestQuery, { requestId })).rows[0]!;
    if (request.status !== 'waiting') {
      throw APPROVAL_REFUSALS.refuse(request.status === 'closed' ? 'changed' : 'alreadyAnswered');
    }
    return request;
  }

  /**
   * Approve, and make the decision as the approver in the same command: the approval first, then
   * the decision's own ops, each judged by its own rules (a manager's limit included). A permit
   * kind makes no decision now: the approval is what the counter uses later.
   */
  async function approveRequestHandler(
    input: z.output<typeof answerRequestInput>,
    ctx: CommandContext,
  ): Promise<CommandHandlerResult<{ requestId: string }>> {
    const request = await waiting(ctx, input.requestId);
    const kind = kindOf(request.kind);
    await ctx.requirePermission(kind.commandPermission);
    const decision =
      kind.handler === undefined
        ? { ops: [] }
        : await kind.handler(
            kind.input.parse(request.input) as never,
            decidingOnce(ctx, request.id),
          );
    const ops: OpDraft[] = [
      ctx.op({
        type: APPROVAL_OP.approved,
        entityType: APPROVAL_ENTITY,
        entityId: request.id,
        payload: { note: input.note },
      }),
      ...decision.ops,
    ];
    return { ops, result: { requestId: request.id } };
  }

  async function rejectRequestHandler(
    input: z.output<typeof answerRequestInput>,
    ctx: CommandContext,
  ): Promise<CommandHandlerResult<{ requestId: string }>> {
    const request = await waiting(ctx, input.requestId);
    return {
      ops: [
        ctx.op({
          type: APPROVAL_OP.rejected,
          entityType: APPROVAL_ENTITY,
          entityId: request.id,
          payload: { note: input.note },
        }),
      ],
      result: { requestId: request.id },
    };
  }

  async function withdrawRequestHandler(
    input: z.output<typeof withdrawRequestInput>,
    ctx: CommandContext,
  ): Promise<CommandHandlerResult<{ requestId: string }>> {
    const request = await waiting(ctx, input.requestId);
    return {
      ops: [
        ctx.op({
          type: APPROVAL_OP.withdrawn,
          entityType: APPROVAL_ENTITY,
          entityId: request.id,
          payload: {},
        }),
      ],
      result: { requestId: request.id },
    };
  }

  return {
    requestApprovalHandler,
    approveRequestHandler,
    rejectRequestHandler,
    withdrawRequestHandler,
  };
}
