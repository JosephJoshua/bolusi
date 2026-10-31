// The `approvals` op rules, run on the device and the server alike (core module/op-rules.ts).
//
// A request asks for one decision another module owns, and approving it records that decision as
// the approver's, in the same command, judged by its own rules. These rules guard the request
// itself: someone who may ask, about something that still stands as it was asked; answered once,
// never by the asker (whatever roles they hold), and only by someone who holds the decision.
import type { Kysely } from 'kysely';

import { defineRefusals, type OpRule } from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';

import type { RequestedPayload } from './applier.js';
import type { ApprovalKind, ApprovalKinds } from './kinds.js';
import type { ApprovalsDatabase } from './schema.js';

type Rule = OpRule<ApprovalsDatabase>;
type Db = Pick<Kysely<ApprovalsDatabase>, 'selectFrom'>;

/** Every reason an approval change is refused, each with its copy at `approvals.refusal.<reason>`. */
export const APPROVAL_REFUSALS = defineRefusals('approvals', [
  'unknownKind',
  'notNeeded',
  'cannotAsk',
  'targetNotFound',
  'changed',
  'alreadyAsked',
  'requestNotFound',
  'alreadyAnswered',
  'ownRequest',
  'cannotDecide',
  'notYours',
  'overLimit',
] as const);
const { refuse } = APPROVAL_REFUSALS;

function storeOf(op: SignedOperation): string {
  return op.storeId ?? '';
}

function asNever(db: Db): Kysely<never> {
  return db as unknown as Kysely<never>;
}

function kindOf(kinds: ApprovalKinds, id: string): ApprovalKind {
  const kind = kinds[id];
  if (kind === undefined) {
    throw refuse('unknownKind', {
      code: 'VALIDATION_FAILED',
      details: { field: 'kind', issue: `no approval kind ${id}` },
    });
  }
  return kind;
}

/** The request's input as its kind reads it; a payload its kind cannot read is refused. */
function inputOf(kind: ApprovalKind, input: unknown): never {
  const parsed = kind.input.safeParse(input);
  if (!parsed.success) {
    throw refuse('notNeeded', {
      code: 'VALIDATION_FAILED',
      details: { field: 'input', issue: parsed.error.issues[0]?.message ?? 'invalid' },
    });
  }
  return parsed.data;
}

/** Whether the request's target still stands as it was asked: same basis, same amount. */
async function requireUnchanged(
  db: Db,
  op: SignedOperation,
  kind: ApprovalKind,
  input: never,
  asked: { readonly basis: string; readonly amount: number },
): Promise<void> {
  const basis = await kind.basis(
    asNever(db),
    { tenantId: op.tenantId, storeId: storeOf(op) },
    input,
  );
  if (basis === null) throw refuse('targetNotFound', { code: 'ENTITY_NOT_FOUND' });
  const amount = await kind.amount(
    asNever(db),
    { tenantId: op.tenantId, storeId: storeOf(op) },
    input,
  );
  if (basis !== asked.basis || amount !== asked.amount) throw refuse('changed');
}

interface WaitingRequest {
  readonly kind: ApprovalKind;
  readonly input: never;
  readonly basis: string;
  readonly amount: number;
  readonly requestedBy: string;
}

async function loadWaiting(db: Db, kinds: ApprovalKinds, op: SignedOperation) {
  const row = await db
    .selectFrom('approvalRequests')
    .select(['kind', 'inputJson', 'basis', 'amount', 'requestedBy', 'status'])
    .where('id', '=', op.entityId)
    .where('tenantId', '=', op.tenantId)
    .where('storeId', '=', storeOf(op))
    .executeTakeFirst();
  if (row === undefined) throw refuse('requestNotFound', { code: 'ENTITY_NOT_FOUND' });
  if (row.status !== 'waiting') throw refuse('alreadyAnswered');
  const kind = kindOf(kinds, row.kind);
  return {
    kind,
    input: inputOf(kind, JSON.parse(row.inputJson)),
    basis: row.basis,
    amount: Number(row.amount),
    requestedBy: row.requestedBy,
  } satisfies WaitingRequest;
}

/** The approver or rejecter: not the asker, and holding the decision. */
async function requireDecider(
  op: SignedOperation,
  ctx: Parameters<Rule>[1],
  request: WaitingRequest,
): Promise<void> {
  if (op.userId === request.requestedBy) {
    throw refuse('ownRequest', {
      code: 'PERMISSION_DENIED',
      details: { permissionId: request.kind.permission },
    });
  }
  if (!(await ctx.holdsPermission(op.userId, request.kind.permission))) {
    throw refuse('cannotDecide', {
      code: 'PERMISSION_DENIED',
      details: { permissionId: request.kind.permission },
    });
  }
}

export function createApprovalRules(kinds: ApprovalKinds) {
  const requestedRule: Rule = async (op, ctx) => {
    const payload = op.payload as unknown as RequestedPayload;
    const kind = kindOf(kinds, payload.kind);
    const input = inputOf(kind, payload.input);
    if (!kind.fits(input)) throw refuse('notNeeded', { code: 'VALIDATION_FAILED' });
    const target = kind.target(input);
    if (
      target.entityType !== payload.target.entityType ||
      target.entityId !== payload.target.entityId
    ) {
      throw refuse('notNeeded', {
        code: 'VALIDATION_FAILED',
        details: { field: 'target', issue: 'not what the input is about' },
      });
    }
    const mayAsk =
      (await ctx.holdsPermission(op.userId, kind.askPermission)) ||
      (await ctx.holdsPermission(op.userId, kind.permission));
    if (!mayAsk) {
      throw refuse('cannotAsk', {
        code: 'PERMISSION_DENIED',
        details: { permissionId: kind.askPermission },
      });
    }
    await requireUnchanged(ctx.db, op, kind, input, payload);
    // One open question per decision on a record: a second would be answered twice.
    const open = await ctx.db
      .selectFrom('approvalRequests')
      .select('id')
      .where('storeId', '=', storeOf(op))
      .where('kind', '=', kind.id)
      .where('targetId', '=', target.entityId)
      .where('status', '=', 'waiting')
      .where('basis', '=', payload.basis)
      .where('id', '!=', op.entityId)
      .executeTakeFirst();
    if (open !== undefined) throw refuse('alreadyAsked');
  };

  const approvedRule: Rule = async (op, ctx) => {
    const request = await loadWaiting(ctx.db, kinds, op);
    await requireDecider(op, ctx, request);
    await requireUnchanged(ctx.db, op, request.kind, request.input, request);
    // The decision's own rules hold the approver to their limit; the approval is held to it too,
    // so a request never reads approved while its decision was refused.
    const counted =
      request.kind.counted === undefined
        ? request.amount
        : await request.kind.counted(
            asNever(ctx.db),
            { tenantId: op.tenantId, storeId: storeOf(op) },
            request.input,
          );
    const limited = request.kind.limitPermission ?? request.kind.permission;
    if (!(await ctx.withinLimit(op.userId, limited, counted))) {
      throw refuse('overLimit', { code: 'PERMISSION_DENIED', details: { permissionId: limited } });
    }
  };

  const rejectedRule: Rule = async (op, ctx) => {
    await requireDecider(op, ctx, await loadWaiting(ctx.db, kinds, op));
  };

  const withdrawnRule: Rule = async (op, ctx) => {
    const request = await loadWaiting(ctx.db, kinds, op);
    if (op.userId !== request.requestedBy) {
      throw refuse('notYours', { code: 'PERMISSION_DENIED' });
    }
  };

  return { requestedRule, approvedRule, rejectedRule, withdrawnRule };
}
