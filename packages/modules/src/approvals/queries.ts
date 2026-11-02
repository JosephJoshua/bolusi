// The `approvals` queries: the requests on one record (a servisan's page), the waiting ones someone
// can answer or asked (the list behind the badge), and what a request would be asked against.
//
// A waiting request whose record changed since it was asked no longer fits: it is shown as closed
// and can never be approved (rules.ts), so nobody acts on a price that is not the price any more.
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { DomainError, type QueryContext, type QueryPage } from '@bolusi/core';
import { zUuid } from '@bolusi/schemas';

import { userNames } from '../shared/user-names.js';
import { APPROVAL_PERMISSION, type ApprovalStatus } from './constants.js';
import type { ApprovalKind, ApprovalKinds } from './kinds.js';
import type { ApprovalRequestsTable, ApprovalsDatabase } from './schema.js';

type Qctx = QueryContext<ApprovalsDatabase>;

/** A request as people see it. `closed` is a waiting one its record has moved on from. */
export interface ApprovalRow {
  readonly id: string;
  readonly kind: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly amount: number;
  readonly reason: string;
  readonly requestedBy: string;
  readonly requestedByName: string | null;
  readonly requestedAt: number;
  readonly status: ApprovalStatus | 'closed';
  readonly decidedBy: string | null;
  readonly decidedByName: string | null;
  readonly decidedAt: number | null;
  readonly note: string | null;
  /** The asker, who may withdraw it while it waits. */
  readonly mine: boolean;
  /** Whether the caller may approve or reject it now. */
  readonly canDecide: boolean;
  /**
   * What approving counts against the approver's limit on `limitedBy`, as the rules count it, so a
   * limited approver sees up front that it is beyond them. Read only while the caller may decide.
   */
  readonly counted: number;
  readonly limitedBy: string | null;
}

function storeOf(qctx: Qctx): string {
  return qctx.storeId ?? '';
}

function scopeOf(qctx: Qctx): { tenantId: string; storeId: string } {
  return { tenantId: qctx.tenantId, storeId: storeOf(qctx) };
}

function asNever(qctx: Qctx): Kysely<never> {
  return qctx.db as unknown as Kysely<never>;
}

function kindOf(kinds: ApprovalKinds, id: string): ApprovalKind {
  const kind = kinds[id];
  if (kind === undefined) {
    throw new DomainError('VALIDATION_FAILED', { field: 'kind', issue: `no approval kind ${id}` });
  }
  return kind;
}

async function rowsOf(
  qctx: Qctx,
  kinds: ApprovalKinds,
  rows: readonly ApprovalRequestsTable[],
): Promise<ApprovalRow[]> {
  const names = await userNames(
    qctx.db,
    rows.flatMap((row) => [row.requestedBy, row.decidedBy]),
  );
  const out: ApprovalRow[] = [];
  for (const row of rows) {
    const kind = kinds[row.kind];
    const input = JSON.parse(row.inputJson) as Record<string, unknown>;
    let status = row.status as ApprovalStatus | 'closed';
    const parsed = kind?.input.safeParse(input);
    if (status === 'waiting') {
      // Closed exactly when approving would be refused as changed: another basis or amount.
      const now =
        kind === undefined || parsed?.success !== true
          ? null
          : {
              basis: await kind.basis(asNever(qctx), scopeOf(qctx), parsed.data as never),
              amount: await kind.amount(asNever(qctx), scopeOf(qctx), parsed.data as never),
            };
      if (now?.basis !== row.basis || now.amount !== Number(row.amount)) status = 'closed';
    }
    const mine = row.requestedBy === qctx.userId;
    const canDecide =
      status === 'waiting' &&
      !mine &&
      kind !== undefined &&
      qctx.hasPermission(kind.permission) &&
      qctx.hasPermission(kind.commandPermission);
    const counted =
      !canDecide || kind?.counted === undefined || parsed?.success !== true
        ? Number(row.amount)
        : await kind.counted(asNever(qctx), scopeOf(qctx), parsed.data as never);
    out.push({
      id: row.id,
      kind: row.kind,
      targetType: row.targetType,
      targetId: row.targetId,
      input,
      amount: Number(row.amount),
      reason: row.reason,
      requestedBy: row.requestedBy,
      requestedByName: names.get(row.requestedBy) ?? null,
      requestedAt: Number(row.requestedAt),
      status,
      decidedBy: row.decidedBy,
      decidedByName: row.decidedBy === null ? null : (names.get(row.decidedBy) ?? null),
      decidedAt: row.decidedAt === null ? null : Number(row.decidedAt),
      note: row.note,
      mine,
      canDecide,
      counted,
      limitedBy: kind === undefined ? null : (kind.limitPermission ?? kind.permission),
    });
  }
  return out;
}

export const approvalRequestsInput = z
  .object({
    /** One record's requests, newest first; left out, the waiting ones the caller asked or may answer. */
    targetId: zUuid.optional(),
    /** Only the caller's own requests, in any state, newest first: so an asker hears the answer. */
    mine: z.literal(true).optional(),
  })
  .strict();

/** The most a list shows; a store never has this many open at once. */
const MAX_ROWS = 200;

export function createApprovalQueries(kinds: ApprovalKinds) {
  const approvalRequestsQuery = {
    name: 'approvalRequests',
    permission: APPROVAL_PERMISSION.use,
    input: approvalRequestsInput,
    handler: async (
      input: z.infer<typeof approvalRequestsInput>,
      qctx: Qctx,
    ): Promise<QueryPage<ApprovalRow>> => {
      let query = qctx.db
        .selectFrom('approvalRequests')
        .selectAll()
        .where('tenantId', '=', qctx.tenantId)
        .where('storeId', '=', storeOf(qctx));
      query =
        input.mine === true
          ? query.where('requestedBy', '=', qctx.userId)
          : input.targetId === undefined
            ? query.where('status', '=', 'waiting')
            : query.where('targetId', '=', input.targetId);
      const rows = await query.orderBy('requestedAt', 'desc').limit(MAX_ROWS).execute();
      const shown = await rowsOf(qctx, kinds, rows);
      return {
        rows:
          input.targetId === undefined && input.mine !== true
            ? shown.filter((row) => row.status === 'waiting' && (row.mine || row.canDecide))
            : shown,
        nextCursor: null,
      };
    },
  } as const;

  const approvalBasisInput = z
    .object({ kind: z.string().min(1), input: z.record(z.string(), z.unknown()) })
    .strict();

  /** What a request for `input` would be asked against: its basis and amount, or null if gone. */
  const approvalBasisQuery = {
    name: 'approvalBasis',
    permission: APPROVAL_PERMISSION.use,
    input: approvalBasisInput,
    handler: async (
      input: z.infer<typeof approvalBasisInput>,
      qctx: Qctx,
    ): Promise<QueryPage<{ readonly basis: string; readonly amount: number } | null>> => {
      const kind = kindOf(kinds, input.kind);
      const parsed = kind.input.parse(input.input) as never;
      const basis = await kind.basis(asNever(qctx), scopeOf(qctx), parsed);
      const amount = await kind.amount(asNever(qctx), scopeOf(qctx), parsed);
      return {
        rows: [basis === null || amount === null ? null : { basis, amount }],
        nextCursor: null,
      };
    },
  } as const;

  const approvalRequestInput = z.object({ requestId: zUuid }).strict();

  const approvalRequestQuery = {
    name: 'approvalRequest',
    permission: APPROVAL_PERMISSION.use,
    input: approvalRequestInput,
    handler: async (
      input: z.infer<typeof approvalRequestInput>,
      qctx: Qctx,
    ): Promise<QueryPage<ApprovalRow>> => {
      const rows = await qctx.db
        .selectFrom('approvalRequests')
        .selectAll()
        .where('id', '=', input.requestId)
        .where('tenantId', '=', qctx.tenantId)
        .where('storeId', '=', storeOf(qctx))
        .execute();
      if (rows.length === 0) {
        throw new DomainError('ENTITY_NOT_FOUND', {
          entityType: 'approval_request',
          entityId: input.requestId,
        });
      }
      return { rows: await rowsOf(qctx, kinds, rows), nextCursor: null };
    },
  } as const;

  return { approvalRequestsQuery, approvalBasisQuery, approvalRequestQuery };
}
