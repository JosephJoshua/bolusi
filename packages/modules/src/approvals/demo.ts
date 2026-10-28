// Approval requests in the browser harness: an in-memory stand-in for the approvals module over a
// demo runtime's own commands, so the gallery and the PC demo can ask, approve, reject and
// withdraw. Approving runs the demo command as whoever is acting, as the real module does.
import { DomainError } from '@bolusi/core';

import { APPROVAL_REFUSALS } from './rules.js';
import type { ApprovalRow } from './queries.js';
import type { ApprovalStatus } from './constants.js';

type Input = Readonly<Record<string, unknown>>;

/** What the demo knows of a kind: who decides it, what it costs and how it is applied. */
export interface DemoApprovalKind {
  readonly permission: string;
  readonly commandPermission: string;
  readonly amount: (input: Input) => number;
  readonly targetId: (input: Input) => string;
  readonly apply: (input: Input) => unknown;
}

export interface DemoActor {
  readonly userId: string;
  readonly name: string;
  readonly can: (permissionId: string) => boolean;
}

interface DemoRequest {
  readonly id: string;
  readonly kind: string;
  readonly input: Input;
  readonly amount: number;
  readonly reason: string;
  readonly requestedBy: string;
  readonly requestedByName: string;
  readonly requestedAt: number;
  status: ApprovalStatus;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: number | null;
  note: string | null;
}

export interface DemoApprovalSeed {
  readonly kind: string;
  readonly input: Input;
  readonly reason: string;
  readonly by: { readonly userId: string; readonly name: string };
  readonly at: number;
}

export function demoApprovals(options: {
  readonly kinds: Readonly<Record<string, DemoApprovalKind>>;
  readonly actor: () => DemoActor;
  readonly now: () => number;
  readonly notify: () => void;
  readonly seed?: readonly DemoApprovalSeed[];
}) {
  const { kinds, actor, now, notify } = options;
  let ids = 0;
  const requests: DemoRequest[] = [];
  const kindOf = (id: string): DemoApprovalKind => {
    const kind = kinds[id];
    if (kind === undefined) throw APPROVAL_REFUSALS.refuse('unknownKind');
    return kind;
  };
  const add = (seed: DemoApprovalSeed): DemoRequest => {
    ids += 1;
    const request: DemoRequest = {
      id: `ap-${String(ids)}`,
      kind: seed.kind,
      input: seed.input,
      amount: kindOf(seed.kind).amount(seed.input),
      reason: seed.reason,
      requestedBy: seed.by.userId,
      requestedByName: seed.by.name,
      requestedAt: seed.at,
      status: 'waiting',
      decidedBy: null,
      decidedByName: null,
      decidedAt: null,
      note: null,
    };
    requests.unshift(request);
    return request;
  };
  for (const seed of options.seed ?? []) add(seed);

  const rowOf = (request: DemoRequest): ApprovalRow => {
    const me = actor();
    const kind = kindOf(request.kind);
    const mine = request.requestedBy === me.userId;
    return {
      id: request.id,
      kind: request.kind,
      targetType: 'repair_ticket',
      targetId: kind.targetId(request.input),
      input: request.input,
      amount: request.amount,
      reason: request.reason,
      requestedBy: request.requestedBy,
      requestedByName: request.requestedByName,
      requestedAt: request.requestedAt,
      status: request.status,
      decidedBy: request.decidedBy,
      decidedByName: request.decidedByName,
      decidedAt: request.decidedAt,
      note: request.note,
      mine,
      canDecide:
        request.status === 'waiting' &&
        !mine &&
        me.can(kind.permission) &&
        me.can(kind.commandPermission),
    };
  };
  const find = (id: string): DemoRequest => {
    const request = requests.find((candidate) => candidate.id === id);
    if (request === undefined) throw APPROVAL_REFUSALS.refuse('requestNotFound');
    if (request.status !== 'waiting') throw APPROVAL_REFUSALS.refuse('alreadyAnswered');
    return request;
  };
  const answer = (request: DemoRequest, status: ApprovalStatus, note: unknown): void => {
    const me = actor();
    request.status = status;
    request.decidedBy = me.userId;
    request.decidedByName = me.name;
    request.decidedAt = now();
    request.note = typeof note === 'string' && note.trim() !== '' ? note.trim() : null;
    notify();
  };

  const page = <T>(rows: readonly T[]) => Promise.resolve({ rows, nextCursor: null });

  return {
    query(name: string, input: Input): Promise<unknown> {
      if (name === 'approvalRequests') {
        const targetId = input['targetId'];
        const rows = requests.map(rowOf);
        return page(
          typeof targetId === 'string'
            ? rows.filter((row) => row.targetId === targetId)
            : rows.filter((row) => row.status === 'waiting' && (row.mine || row.canDecide)),
        );
      }
      if (name === 'approvalRequest') return page([rowOf(find(String(input['requestId'])))]);
      if (name === 'approvalBasis') {
        const asked = (input['input'] ?? {}) as Input;
        return page([{ basis: 'demo', amount: kindOf(String(input['kind'])).amount(asked) }]);
      }
      return Promise.reject(new DomainError('VALIDATION_FAILED', { query: name }));
    },
    run(name: string, input: Input): Promise<unknown> {
      try {
        const me = actor();
        switch (name) {
          case 'requestApproval': {
            const kind = String(input['kind']);
            const asked = input['input'] as Input;
            const target = kindOf(kind).targetId(asked);
            if (
              requests.some(
                (r) =>
                  r.status === 'waiting' &&
                  r.kind === kind &&
                  kindOf(kind).targetId(r.input) === target,
              )
            ) {
              throw APPROVAL_REFUSALS.refuse('alreadyAsked');
            }
            const request = add({
              kind,
              input: asked,
              reason: String(input['reason']),
              by: me,
              at: now(),
            });
            notify();
            return Promise.resolve({ requestId: request.id });
          }
          case 'approveRequest': {
            const request = find(String(input['requestId']));
            if (request.requestedBy === me.userId) throw APPROVAL_REFUSALS.refuse('ownRequest');
            kindOf(request.kind).apply(request.input);
            answer(request, 'approved', input['note']);
            return Promise.resolve({ requestId: request.id });
          }
          case 'rejectRequest': {
            const request = find(String(input['requestId']));
            if (request.requestedBy === me.userId) throw APPROVAL_REFUSALS.refuse('ownRequest');
            answer(request, 'rejected', input['note']);
            return Promise.resolve({ requestId: request.id });
          }
          case 'withdrawRequest': {
            const request = find(String(input['requestId']));
            if (request.requestedBy !== me.userId) throw APPROVAL_REFUSALS.refuse('notYours');
            answer(request, 'withdrawn', null);
            return Promise.resolve({ requestId: request.id });
          }
        }
        throw new DomainError('VALIDATION_FAILED', { command: name });
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
}
