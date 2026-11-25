// Perlu dicek: what waits on an owner or Manajer across the store's places, read in one go. The
// requests they may answer come first, one row each; the rest are counts that open the list where
// they are worked off (phones not collected, stock below zero, orders partly in). Every part is read
// only for whoever may act on it, so nobody is shown a number they cannot do anything about.
import { APPROVAL_PERMISSION } from '../approvals/constants.js';
import type { ApprovalRow } from '../approvals/queries.js';
import { INVENTORY_PERMISSION } from '../inventory/constants.js';
import { opensPurchasing } from '../purchasing/constants.js';
import type { OrderRow } from '../purchasing/queries.js';
import {
  APPROVALS_VIEW_MAX,
  boardFilter,
  flagsUncollected,
  repairAbilities,
  uncollectedBefore,
} from './flows.js';
import type { RepairKey } from './i18n.js';
import type { TicketSummaryRow } from './queries.js';
import type { RepairRuntime } from './runtime.js';

/**
 * The approval requests a screen shows: a servisan's (`targetId`), or the ones waiting on this
 * user. None for someone without approvals, so their board and servisan still read.
 */
export async function readApprovals(
  runtime: RepairRuntime,
  targetId?: string,
): Promise<readonly ApprovalRow[]> {
  if (!runtime.approvals.hasPermission(APPROVAL_PERMISSION.use)) return [];
  const input = targetId === undefined ? {} : { targetId };
  return (await runtime.approvals.query('approvalRequests', input)).rows;
}

/** A request this person may answer, with the servisan it is on (null when it is not here yet). */
export interface AttentionRequest {
  readonly request: ApprovalRow;
  readonly ticket: TicketSummaryRow | null;
}

export interface Attention {
  readonly requests: readonly AttentionRequest[];
  /** Null where this person is not told: they could not act on it. */
  readonly uncollected: number | null;
  readonly belowZero: number | null;
  readonly partlyReceived: number | null;
}

/** The pages of open orders read to count the partly received ones; enough for any real store. */
const ORDER_PAGE = 200;
const ORDER_PAGES_MAX = 5;

export async function readAttention(rt: RepairRuntime, now: number): Promise<Attention> {
  const waiting = (await readApprovals(rt)).filter((row) => row.canDecide);
  const ids = [...new Set(waiting.map((row) => row.targetId))].slice(0, APPROVALS_VIEW_MAX);
  const tickets =
    ids.length === 0
      ? []
      : (
          await rt.query('listTickets', {
            filter: { ids },
            sort: 'createdAt.desc',
            limit: APPROVALS_VIEW_MAX,
          })
        ).rows;
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  // Oldest first: whoever asked first has waited longest.
  const requests = [...waiting]
    .sort((a, b) => a.requestedAt - b.requestedAt)
    .map((request) => ({ request, ticket: byId.get(request.targetId) ?? null }));

  const can = repairAbilities(rt.hasPermission);
  let uncollected: number | null = null;
  if (flagsUncollected(can)) {
    const days = (await rt.query('uncollectedDays', {})).rows[0]!.days;
    uncollected =
      (
        await rt.query('countTickets', {
          filter: boardFilter('uncollected', rt.userId, uncollectedBefore(days, now)),
        })
      ).rows[0]?.count ?? 0;
  }

  const inventory = rt.inventory;
  const belowZero =
    inventory?.hasPermission(INVENTORY_PERMISSION.manageItems) === true
      ? ((await inventory.query('countBelowZero', {})).rows[0]?.count ?? 0)
      : null;

  const purchasing = rt.purchasing;
  let partlyReceived: number | null = null;
  if (purchasing !== undefined && opensPurchasing(inventory, purchasing)) {
    let open: OrderRow[] = [];
    let offset = 0;
    for (let n = 0; n < ORDER_PAGES_MAX; n += 1) {
      const page = await purchasing.query('listOrders', {
        filter: 'open',
        limit: ORDER_PAGE,
        offset,
      });
      open = [...open, ...page.rows];
      if (page.nextCursor === null) break;
      offset = Number(page.nextCursor);
    }
    partlyReceived = open.filter((order) => order.stage === 'partial').length;
  }

  return { requests, uncollected, belowZero, partlyReceived };
}

/** The other things Perlu dicek counts, each opening where it is worked off. */
export const ATTENTION_COUNTS = ['uncollected', 'belowZero', 'partlyReceived', 'refused'] as const;
export type AttentionCount = (typeof ATTENTION_COUNTS)[number];

export const ATTENTION_COUNT_KEY: Readonly<Record<AttentionCount, RepairKey>> = {
  uncollected: 'repair.attention.uncollected',
  belowZero: 'repair.attention.belowZero',
  partlyReceived: 'repair.attention.partlyReceived',
  refused: 'repair.attention.refused',
};

/** How many of `key` wait; `refused` is this person's own refused changes, which the shell knows. */
export function attentionCount(key: AttentionCount, attention: Attention, refused: number): number {
  switch (key) {
    case 'uncollected':
      return attention.uncollected ?? 0;
    case 'belowZero':
      return attention.belowZero ?? 0;
    case 'partlyReceived':
      return attention.partlyReceived ?? 0;
    case 'refused':
      return refused;
  }
}

/** Whether anything waits at all: an empty Perlu dicek says so instead of showing empty sections. */
export function attentionEmpty(attention: Attention, refused: number): boolean {
  return (
    attention.requests.length === 0 &&
    ATTENTION_COUNTS.every((key) => attentionCount(key, attention, refused) === 0)
  );
}
