// The servisan table's narrowing on any client: the facets someone picked (status, technician,
// received date, brand, prices waiting), the column they sorted by, and the page they are on. One
// definition turns them into a `listTickets` read for a queue, and applies them to ranked search
// results the same way, so a filter means the same thing in both.
import { IN_PROGRESS_OUTCOMES, REPAIR_OUTCOMES, type RepairOutcome } from './constants.js';
import {
  amountOwed,
  boardFilter,
  boardSort,
  ticketStatus,
  type BoardView,
  type TicketStatus,
} from './flows.js';
import type { TicketFilter, TicketSort, TicketSummaryRow } from './queries.js';
import { dayRangeBounds, type DayRange } from '../screen-kit/days.js';

export {
  dayOf,
  dayRangeBounds,
  DAY_PRESETS as RECEIVED_PRESETS,
  presetRange,
  type DayPreset as ReceivedPreset,
  type DayRange,
} from '../screen-kit/days.js';

/** The technician facet's choice for tickets nobody holds yet. */
export const UNASSIGNED = 'unassigned';

export interface TicketFacets {
  /** As the status chip says it: an outcome, or "returned" once the phone is back with its owner. */
  readonly statuses: readonly TicketStatus[];
  /** Technician ids, and `UNASSIGNED` for tickets nobody holds. */
  readonly technicians: readonly string[];
  readonly received: DayRange | null;
  readonly brands: readonly string[];
  readonly priceWaiting: boolean;
}

export const NO_FACETS: TicketFacets = {
  statuses: [],
  technicians: [],
  received: null,
  brands: [],
  priceWaiting: false,
};

export function facetCount(facets: TicketFacets): number {
  return (
    (facets.statuses.length > 0 ? 1 : 0) +
    (facets.technicians.length > 0 ? 1 : 0) +
    (facets.received === null ? 0 : 1) +
    (facets.brands.length > 0 ? 1 : 0) +
    (facets.priceWaiting ? 1 : 0)
  );
}

/** Every status a search can find. */
export const TICKET_STATUSES: readonly TicketStatus[] = [...REPAIR_OUTCOMES, 'returned'];

/**
 * The statuses worth offering in a queue: the ones it can hold. Search spans every ticket, so it
 * offers them all. The returned and cancelled queues each hold one status, so they offer none.
 */
export function statusChoices(view: BoardView | 'search'): readonly TicketStatus[] {
  switch (view) {
    case 'search':
      return TICKET_STATUSES;
    case 'active':
    case 'mine':
    case 'unassigned':
      return IN_PROGRESS_OUTCOMES;
    case 'pickup':
    case 'uncollected':
      return ['repaired', 'cancelled'];
    case 'returned':
    case 'cancelled':
      return [];
  }
}

/** Whether a queue already decides who holds its tickets, so a technician facet adds nothing. */
export function technicianChoice(view: BoardView): boolean {
  return view !== 'mine' && view !== 'unassigned';
}

/**
 * The `listTickets` filter for a queue narrowed by the facets; `readyBefore` and `approvalIds` as
 * `boardFilter`.
 */
export function tableFilter(
  view: BoardView,
  userId: string,
  readyBefore: number,
  facets: TicketFacets,
): TicketFilter {
  const base: TicketFilter = boardFilter(view, userId, readyBefore) ?? {};
  const filter: { -readonly [K in keyof TicketFilter]: TicketFilter[K] } = { ...base };
  if (facets.statuses.length > 0) {
    // Only the statuses this queue holds (every queue that offers a status keeps its phones in the
    // store, so a status there is an outcome); the board drops the rest when the queue changes.
    const allowed = statusChoices(view);
    const outcomes = facets.statuses.filter(
      (status): status is RepairOutcome => status !== 'returned' && allowed.includes(status),
    );
    if (outcomes.length > 0) filter.outcomes = [...outcomes];
  }
  if (technicianChoice(view) && facets.technicians.length > 0) {
    const ids = facets.technicians.filter((id) => id !== UNASSIGNED);
    if (ids.length > 0) filter.technicianIds = ids;
    if (facets.technicians.includes(UNASSIGNED)) filter.unassigned = true;
  }
  if (facets.received !== null) {
    const { from, before } = dayRangeBounds(facets.received);
    if (from !== undefined) filter.receivedFrom = from;
    if (before !== undefined) filter.receivedBefore = before;
  }
  if (facets.brands.length > 0) filter.brands = [...facets.brands];
  if (facets.priceWaiting) filter.hasPendingProposals = true;
  return filter;
}

/**
 * The facets a queue can use, so a choice made elsewhere (in search, or another queue) never
 * narrows a list without showing on the toolbar.
 */
export function facetsFor(view: BoardView, facets: TicketFacets): TicketFacets {
  return {
    ...facets,
    statuses: facets.statuses.filter((status) => statusChoices(view).includes(status)),
    technicians: technicianChoice(view) ? facets.technicians : [],
  };
}

/** The facets applied to search results, the same way `tableFilter` narrows a queue. */
export function matchesFacets(row: TicketSummaryRow, facets: TicketFacets): boolean {
  if (facets.statuses.length > 0 && !facets.statuses.includes(ticketStatus(row))) return false;
  if (facets.technicians.length > 0) {
    const held =
      row.technicianId === null
        ? facets.technicians.includes(UNASSIGNED)
        : facets.technicians.includes(row.technicianId);
    if (!held) return false;
  }
  if (facets.received !== null) {
    const { from, before } = dayRangeBounds(facets.received);
    if (from !== undefined && row.createdAt < from) return false;
    if (before !== undefined && row.createdAt >= before) return false;
  }
  if (facets.brands.length > 0) {
    const brand = row.deviceBrand.trim().toLowerCase();
    if (!facets.brands.some((choice) => choice.trim().toLowerCase() === brand)) return false;
  }
  if (facets.priceWaiting && row.pendingProposals === 0) return false;
  return true;
}

/** The table columns a person can sort by, and the query sort behind each. */
export const SORTABLE_COLUMNS = ['number', 'customer', 'received', 'total'] as const;
export type SortableColumn = (typeof SORTABLE_COLUMNS)[number];

export interface ColumnSort {
  readonly column: SortableColumn;
  readonly descending: boolean;
}

/**
 * Whether a queue can sort by this column. Customer names are encrypted on the device, so only
 * search results (already decrypted in memory) sort by name.
 */
export function queueSortable(column: SortableColumn): boolean {
  return column !== 'customer';
}

/** The query sort for a column sort, or the queue's own order when nothing is sorted. */
export function tableSort(view: BoardView, sort: ColumnSort | null): TicketSort {
  if (sort === null || !queueSortable(sort.column)) return boardSort(view);
  const direction = sort.descending ? 'desc' : 'asc';
  return sort.column === 'received'
    ? `createdAt.${direction}`
    : `${sort.column as 'number' | 'total'}.${direction}`;
}

/** Sorts search results by a column, the way the query sorts a queue; unsorted keeps the ranking. */
export function sortRows(
  rows: readonly TicketSummaryRow[],
  sort: ColumnSort | null,
): readonly TicketSummaryRow[] {
  if (sort === null) return rows;
  const value = (row: TicketSummaryRow): number | string => {
    switch (sort.column) {
      case 'number':
        return row.ticketNumber;
      case 'customer':
        return row.customerName;
      case 'received':
        return row.createdAt;
      case 'total':
        return amountOwed(row);
    }
  };
  const sign = sort.descending ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    const order =
      typeof x === 'string' && typeof y === 'string'
        ? x.localeCompare(y, 'id')
        : Number(x) - Number(y);
    return order === 0 ? b.createdAt - a.createdAt : sign * order;
  });
}
