// The servisan table's narrowing on any client: the facets someone picked (status, technician,
// received date, brand, prices waiting), the column they sorted by, and the page they are on. One
// definition turns them into a `listTickets` read for a queue, and applies them to ranked search
// results the same way, so a filter means the same thing in both.
import { IN_PROGRESS_OUTCOMES, REPAIR_OUTCOMES, type RepairOutcome } from './constants.js';
import {
  boardFilter,
  boardSort,
  ticketStatus,
  type BoardView,
  type TicketStatus,
} from './flows.js';
import type { TicketFilter, TicketSort, TicketSummaryRow } from './queries.js';

/** The technician facet's choice for tickets nobody holds yet. */
export const UNASSIGNED = 'unassigned';

/** A received-date range as calendar days (yyyy-mm-dd, the store's local time), either end open. */
export interface DayRange {
  readonly from: string | null;
  readonly to: string | null;
}

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

/** Local midnight of a yyyy-mm-dd day, as epoch ms. */
function dayStart(day: string): number {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, date).getTime();
}

/** The epoch-ms bounds of a day range: from the first day's start to the day after the last. */
export function dayRangeBounds(range: DayRange): {
  readonly from: number | undefined;
  readonly before: number | undefined;
} {
  const before =
    range.to === null
      ? undefined
      : (() => {
          const end = new Date(dayStart(range.to));
          end.setDate(end.getDate() + 1);
          return end.getTime();
        })();
  return { from: range.from === null ? undefined : dayStart(range.from), before };
}

/** A local calendar day as yyyy-mm-dd. */
export function dayOf(at: number): string {
  const date = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const RECEIVED_PRESETS = ['today', 'last7', 'last30', 'thisMonth'] as const;
export type ReceivedPreset = (typeof RECEIVED_PRESETS)[number];

/** The day range a quick choice stands for, counted from `now`. */
export function presetRange(preset: ReceivedPreset, now: number): DayRange {
  const today = dayOf(now);
  const daysAgo = (n: number): string => {
    const date = new Date(dayStart(today));
    date.setDate(date.getDate() - n);
    return dayOf(date.getTime());
  };
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'last7':
      return { from: daysAgo(6), to: today };
    case 'last30':
      return { from: daysAgo(29), to: today };
    case 'thisMonth':
      return { from: `${today.slice(0, 8)}01`, to: today };
  }
}

/** The `listTickets` filter for a queue narrowed by the facets. */
export function tableFilter(view: BoardView, userId: string, facets: TicketFacets): TicketFilter {
  const base: TicketFilter = boardFilter(view, userId) ?? {};
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

/** What the customer owes on a row: a cancelled servisan's fee, never its repair price. */
export function rowTotal(row: TicketSummaryRow): number {
  return row.outcome === 'cancelled' ? (row.cancelFee ?? 0) : row.quoteTotal;
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
        return rowTotal(row);
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
