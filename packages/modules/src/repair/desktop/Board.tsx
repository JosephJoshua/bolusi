// The counter's main page: the store's repairs as a table, search first, with the selected repair
// open beside it. Typing searches every ticket with the shared fuzzy index (names with Indonesian
// spelling tolerance, any phone format, ticket number, IMEI, model); with no text the table shows
// one queue. Either way the toolbar's filters narrow it, a header sorts it and the footer pages it.
// Keyboard first: "/" searches, arrows move, Enter moves into the open servisan, Esc closes it, F2
// starts intake.
import { FuzzyIndex } from '@bolusi/core';
import { formatDate, formatMoney, formatNumber, formatPhone, formatTime, t } from '@bolusi/i18n';
import {
  Button,
  ColumnsMenu,
  DataTable,
  DayRangeFilter,
  FilterToggle,
  OptionsFilter,
  OverflowText,
  PageHeader,
  Pagination,
  SearchField,
  StatePanel,
  Tabs,
  Tooltip,
  type ColumnDef,
  type DayRangeValue,
  type FilterOption,
} from '@bolusi/ui-web';
import { ClipboardList, CloudOff, FilterX, Plus, SearchX, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { statusesFor, useTick, type EntitySyncStatuses } from '../../screen-kit/index.js';
import {
  amountOwed,
  BOARD_EMPTY_KEY,
  boardFilter,
  boardViewLabel,
  boardViews,
  countsPickup,
  pointsToPickup,
  UNCOLLECTED_REFRESH_MS,
  defaultBoardView,
  flagsUncollected,
  repairAbilities,
  ticketStatus,
  uncollectedBefore,
  uncollectedDays,
  type BoardView,
  type IntakeDraft,
  type RepairAbilities,
  type TicketStatus,
} from '../flows.js';
import type { TicketSummaryRow } from '../queries.js';
import { tn } from '../i18n.js';
import { statusLabel } from '../labels.js';
import { readApprovals, useRepairQuery, useRepairRuntime } from '../runtime.js';
import {
  NO_FACETS,
  RECEIVED_PRESETS,
  UNASSIGNED,
  facetCount,
  facetsFor,
  matchesFacets,
  statusChoices,
  presetRange,
  sortRows,
  tableFilter,
  tableSort,
  technicianChoice,
  type ColumnSort,
  type SortableColumn,
  type TicketFacets,
} from '../table.js';

import { QueryPanel, overlayOpen, typingInField } from '../../screen-kit/desktop/index.js';
import { StatusChip } from './parts.js';
import { TicketPane } from './TicketPane.js';

/** Search is ranked, so its best matches are the ones worth filtering and paging. */
const SEARCH_LIMIT = 100;

export interface RepairBoardPageProps {
  /** The repair open beside the table, owned by the app so a new intake can open its ticket. */
  readonly selectedTicketId: string | null;
  readonly onSelectTicket: (ticketId: string | null) => void;
  /** The servisan an intake opened just now: its number is stamped in when its pane shows. */
  readonly justOpenedTicketId?: string | null | undefined;
  /** The servisan an intake just opened, whose slip the pane offers at once. */
  readonly openedTicketId?: string | null | undefined;
  readonly onOpenedShown?: (() => void) | undefined;
  readonly onNewIntake: () => void;
  /** An unsaved intake or warranty claim this person left: "Servisan baru" says it carries on with it. */
  readonly waitingDraft?: 'intake' | 'claim' | null | undefined;
  /** Starts a warranty claim's intake from the open servisan. */
  readonly onStartClaim?: ((draft: IntakeDraft) => void) | undefined;
  readonly onOpenSyncStatus?: (() => void) | undefined;
  /** The queue, search, filters, sort and page, owned by the app so they survive a trip to the
   * intake page. Null starts on the person's default queue. */
  readonly filters: BoardFilters | null;
  readonly onFiltersChange: (filters: BoardFilters) => void;
  /** The clock the date filter's quick choices count from. */
  readonly now?: (() => number) | undefined;
}

export interface BoardFilters {
  readonly view: BoardView;
  readonly text: string;
  readonly facets: TicketFacets;
  readonly sort: ColumnSort | null;
  /** From 1. */
  readonly page: number;
  readonly pageSize: number;
  readonly hiddenColumns: readonly string[];
}

const PAGE_SIZES = [25, 50, 100] as const;

function defaultFilters(can: RepairAbilities): BoardFilters {
  return {
    view: defaultBoardView(can),
    text: '',
    facets: NO_FACETS,
    sort: null,
    page: 1,
    pageSize: 50,
    hiddenColumns: [],
  };
}

interface LoadedBoard {
  /** The queue or search these rows answer, so rows from the last one are never acted on. */
  readonly scope: string;
  readonly rows: readonly TicketSummaryRow[];
  /** Every row the filters let through, on all pages. */
  readonly total: number;
  readonly statuses: EntitySyncStatuses;
  /** The store's not-collected limit in days, and the time the rows were read against it. */
  readonly uncollectedLimit: number;
  readonly readAt: number;
  /** Servisan waiting on this user's approval, and those with any waiting request they see. */
  readonly approvalIds: readonly string[];
  readonly approvalWaiting: ReadonlySet<string>;
  /** Phones waiting for pickup, for the tab and an empty active queue; null when not counted. */
  readonly pickup: number | null;
}

/** The filter options matching typed text, best first, with the app's typo-tolerant search. */
function fuzzyOptions(options: readonly FilterOption[], text: string): FilterOption[] {
  const index = new FuzzyIndex(
    options.map((option, rank) => ({ id: option.value, text: [option.label], rank: -rank })),
  );
  const byValue = new Map(options.map((option) => [option.value, option]));
  return index.search(text, options.length).map((hit) => byValue.get(hit.id)!);
}

export function RepairBoardPage({
  selectedTicketId,
  onSelectTicket,
  justOpenedTicketId = null,
  openedTicketId = null,
  onOpenedShown,
  onNewIntake,
  waitingDraft = null,
  onStartClaim,
  onOpenSyncStatus,
  filters,
  onFiltersChange,
  now: clock = Date.now,
}: RepairBoardPageProps): React.JSX.Element {
  const runtime = useRepairRuntime();
  const can = useMemo(() => repairAbilities(runtime.hasPermission), [runtime]);
  const state = filters ?? defaultFilters(can);
  const { view, text, facets, sort, page, pageSize, hiddenColumns } = state;
  /** Any change but a page turn starts again from the first page. */
  const update = (patch: Partial<BoardFilters>): void =>
    onFiltersChange({ ...state, page: 1, ...patch });
  const setFacets = (patch: Partial<TicketFacets>): void =>
    update({ facets: { ...facets, ...patch } });
  const [reloadNonce, setReloadNonce] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  // Closing the pane hands the keyboard back to the table, where the person left it.
  const closePane = (): void => {
    onSelectTicket(null);
    tableRef.current?.focus();
  };
  const searching = text.trim() !== '';
  // Re-read now and then, so a phone passes into "not collected" on a board nobody touches.
  const hour = useTick(UNCOLLECTED_REFRESH_MS);
  const scope = JSON.stringify([
    searching ? `q:${text.trim()}` : view,
    facets,
    sort,
    page,
    pageSize,
  ]);

  const query = useRepairQuery<LoadedBoard>(
    async (rt) => {
      let rows: readonly TicketSummaryRow[];
      let total: number;
      const uncollectedLimit = (await rt.query('uncollectedDays', {})).rows[0]!.days;
      const readAt = clock();
      const requests = await readApprovals(rt);
      const approvalIds = [
        ...new Set(requests.filter((row) => row.canDecide).map((row) => row.targetId)),
      ];
      const approvalWaiting = new Set(requests.map((row) => row.targetId));
      if (searching) {
        // Search ranks across every ticket; the filters, sort and pages then apply to its matches.
        const found = (await rt.query('searchTickets', { text: text.trim(), limit: SEARCH_LIMIT }))
          .rows;
        const kept = sortRows(
          found.filter((row) => matchesFacets(row, facets)),
          sort,
        );
        total = kept.length;
        rows = kept.slice((page - 1) * pageSize, page * pageSize);
      } else if (view === 'approvals' && approvalIds.length === 0) {
        // Every request answered: nothing to list, and the view goes.
        rows = [];
        total = 0;
      } else {
        const filter = tableFilter(
          view,
          rt.userId,
          uncollectedBefore(uncollectedLimit, readAt),
          facets,
          approvalIds,
        );
        const [list, count] = await Promise.all([
          rt.query('listTickets', {
            filter,
            sort: tableSort(view, sort),
            offset: (page - 1) * pageSize,
            limit: pageSize,
          }),
          // Counted exactly as listed: the cancel-date order also leaves out undated cancels.
          rt.query('countTickets', {
            filter,
            cancelledOnly: tableSort(view, sort) === 'cancelledAt.desc',
          }),
        ]);
        rows = list.rows;
        total = count.rows[0]?.count ?? 0;
      }
      const statuses = await rt.ticketSyncStatuses(rows.map((row) => row.id));
      // The tabs are hidden while searching, so the count waits until the search is cleared.
      const pickup =
        !searching && countsPickup(can)
          ? ((await rt.query('countTickets', { filter: boardFilter('pickup', rt.userId, 0) }))
              .rows[0]?.count ?? 0)
          : null;
      return {
        scope,
        pickup,
        rows,
        total,
        statuses,
        uncollectedLimit,
        readAt,
        approvalIds,
        approvalWaiting,
      };
    },
    `desk.board:${scope}:${String(reloadNonce)}:${String(hour)}`,
  );
  const loaded = query.status === 'ready' ? query.data : null;
  // The last page's rows stay up while the next one reads, so the table does not flash; they
  // cannot be opened meanwhile, and the count waits for the new rows.
  const stale = loaded !== null && loaded.scope !== scope;

  // A page past the end (rows synced away, or a narrower filter elsewhere) falls back to the last.
  const pageCount = loaded === null ? 1 : Math.max(1, Math.ceil(loaded.total / pageSize));
  useEffect(() => {
    if (!stale && loaded !== null && page > pageCount)
      onFiltersChange({ ...state, page: pageCount });
  });
  const waitingApprovals = loaded?.approvalIds.length ?? 0;
  // Every request answered: the approvals view goes, and the board returns to its usual queue.
  useEffect(() => {
    if (!stale && loaded !== null && view === 'approvals' && waitingApprovals === 0)
      onFiltersChange({ ...state, view: defaultFilters(can).view, page: 1 });
  });

  const options = useRepairQuery(
    async (rt) => {
      const [technicians, brands] = await Promise.all([
        rt.technicians(),
        rt.query('ticketBrands', {}),
      ]);
      return { technicians, brands: brands.rows };
    },
    `desk.board.options:${String(reloadNonce)}`,
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Page shortcuts are off while a dialog or menu is up; it owns the keyboard, Escape included.
      // Listening in the capture phase sees the key before the dialog closes itself on it.
      // (A filter's popover is a dialog too; a tooltip is not, so hovering never mutes the keys.)
      if (overlayOpen()) return;
      if (event.key === 'F2' && can.intake) {
        event.preventDefault();
        onNewIntake();
      } else if (
        (event.key === '/' || (event.key === 'k' && event.ctrlKey)) &&
        !typingInField(event.target)
      ) {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (
        event.key === 'Escape' &&
        selectedTicketId !== null &&
        !typingInField(event.target)
      ) {
        closePane();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [can.intake, onNewIntake, onSelectTicket, selectedTicketId]);

  const showCancel = !searching && view === 'cancelled';
  const columns = useMemo(
    () =>
      boardColumns({
        statuses: loaded?.statuses ?? {},
        showCancel,
        searching,
        // The counter and owners call the customer about a phone left too long.
        waited:
          flagsUncollected(can) && loaded !== null
            ? (row) => uncollectedDays(row, loaded.uncollectedLimit, loaded.readAt)
            : () => null,
        approvalWaiting: (row) => loaded?.approvalWaiting.has(row.id) === true,
      }),
    [loaded, showCancel, searching, can],
  );
  const filtered = facetCount(facets) > 0;

  const empty =
    query.status === 'unauthorized' || query.status === 'error' ? (
      <QueryPanel query={query} onRetry={() => setReloadNonce((n) => n + 1)}>
        {() => null}
      </QueryPanel>
    ) : filtered ? (
      <StatePanel
        icon={FilterX}
        title={tn('repair.desk.filter.empty')}
        action={
          <Button
            label={tn('repair.desk.filter.reset')}
            onClick={() => update({ facets: NO_FACETS })}
          />
        }
      />
    ) : searching ? (
      <StatePanel icon={SearchX} title={tn('repair.board.noMatches')} />
    ) : (
      <StatePanel
        icon={ClipboardList}
        title={tn(BOARD_EMPTY_KEY[view])}
        {...(pointsToPickup(view, searching, loaded?.pickup ?? null)
          ? {
              // Nothing being worked on, but customers are due: the way to them, not a dead end.
              action: (
                <Button
                  label={tn('repair.board.pickupWaiting', { count: loaded?.pickup ?? 0 })}
                  onClick={() => update({ view: 'pickup', facets: facetsFor('pickup', facets) })}
                  data-testid="repair.desk.board.toPickup"
                />
              ),
            }
          : view === 'active'
            ? { hint: tn('repair.board.emptyHint') }
            : {})}
      />
    );

  const filterLabels = {
    clear: tn('repair.desk.filter.clear'),
    search: tn('repair.desk.filter.search'),
    noMatches: tn('repair.desk.filter.noMatches'),
  };
  const chosen = (count: number): string => tn('repair.desk.filter.chosen', { count });
  const statusOptions = statusChoices(searching ? 'search' : view);
  const now = clock();
  const toolbar = (
    <div
      className="@container flex h-12 items-center gap-2 px-6"
      data-testid="repair.desk.board.filters"
    >
      {/* One row that scrolls sideways when the pane leaves it little room, never a second row.
          The right edge fades, so a filter running under it reads as more to scroll to. */}
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto pr-6 [mask-image:linear-gradient(to_right,black_calc(100%-32px),transparent)] [scrollbar-width:none]">
        {statusOptions.length > 0 ? (
          <OptionsFilter
            label={tn('repair.desk.filter.status')}
            options={statusOptions.map((status) => ({ value: status, label: statusLabel(status) }))}
            selected={facets.statuses}
            onChange={(statuses) => setFacets({ statuses: statuses as TicketStatus[] })}
            summarize={chosen}
            labels={filterLabels}
            testId="repair.desk.filter.status"
          />
        ) : null}
        {searching || technicianChoice(view) ? (
          <OptionsFilter
            label={tn('repair.desk.filter.technician')}
            options={[
              { value: UNASSIGNED, label: tn('repair.ticket.unassigned') },
              ...(options.status === 'ready' ? options.data.technicians : []).map((person) => ({
                value: person.id,
                label: person.name,
              })),
            ]}
            selected={facets.technicians}
            onChange={(technicians) => setFacets({ technicians })}
            summarize={chosen}
            labels={filterLabels}
            match={fuzzyOptions}
            testId="repair.desk.filter.technician"
          />
        ) : null}
        <DayRangeFilter
          label={tn('repair.desk.filter.received')}
          value={facets.received}
          presets={RECEIVED_PRESETS.map((preset) => ({
            key: preset,
            label: tn(`repair.desk.filter.${preset}`),
            range: presetRange(preset, now),
          }))}
          onChange={(received) => setFacets({ received })}
          summarize={(range) => dayRangeText(range)}
          labels={{
            clear: filterLabels.clear,
            from: tn('repair.desk.filter.from'),
            to: tn('repair.desk.filter.to'),
          }}
          testId="repair.desk.filter.received"
        />
        <OptionsFilter
          label={tn('repair.desk.filter.brand')}
          // Keyed by the brand in lower case, the way the query compares brands, so a later
          // "SAMSUNG" spelling never unticks a chosen "Samsung".
          options={(options.status === 'ready' ? options.data.brands : []).map((row) => ({
            value: row.brand.toLowerCase(),
            label: row.brand,
            count: row.count,
          }))}
          selected={facets.brands}
          onChange={(brands) => setFacets({ brands })}
          summarize={chosen}
          labels={filterLabels}
          match={fuzzyOptions}
          testId="repair.desk.filter.brand"
        />
        <FilterToggle
          label={tn('repair.board.priceChangeWaiting')}
          icon={TriangleAlert}
          pressed={facets.priceWaiting}
          onChange={(priceWaiting) => setFacets({ priceWaiting })}
          collapse
          testId="repair.desk.filter.priceWaiting"
        />
        {filtered ? (
          <Button
            variant="text"
            size="sm"
            label={tn('repair.desk.filter.reset')}
            onClick={() => update({ facets: NO_FACETS })}
            data-testid="repair.desk.filter.reset"
          />
        ) : null}
      </div>
      <div className="shrink-0">
        <ColumnsMenu
          label={tn('repair.desk.table.columns')}
          columns={columns.map((column) => ({
            id: column.id!,
            label: String(column.header),
            visible: !hiddenColumns.includes(column.id!),
            locked: LOCKED_COLUMNS.includes(column.id!),
          }))}
          onToggle={(id, visible) =>
            onFiltersChange({
              ...state,
              hiddenColumns: visible
                ? hiddenColumns.filter((other) => other !== id)
                : [...hiddenColumns, id],
            })
          }
          testId="repair.desk.table.columns"
        />
      </div>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="repair.desk.board">
      <PageHeader
        title={tn('repair.board.title')}
        actions={
          can.intake ? (
            <Button
              label={tn(
                waitingDraft === 'claim'
                  ? 'repair.action.resumeClaim'
                  : waitingDraft === 'intake'
                    ? 'repair.action.resumeIntake'
                    : 'repair.action.newIntake',
              )}
              // One filled button on screen: an open servisan has its own next step.
              variant={selectedTicketId === null ? 'primary' : 'secondary'}
              icon={Plus}
              shortcut="F2"
              onClick={onNewIntake}
              data-testid="repair.desk.board.newIntake"
            />
          ) : undefined
        }
      >
        <SearchField
          ref={searchRef}
          value={text}
          onChange={(next) =>
            update(
              next.trim() === ''
                ? // Back to the queue: drop what only search offered, and keep the queue's order.
                  { text: next, facets: facetsFor(view, facets), sort: null }
                : { text: next, sort: searching ? sort : null },
            )
          }
          placeholder={tn('repair.board.searchHint')}
          label={t('core.action.search')}
          clearLabel={tn('repair.board.clearSearch')}
          shortcut="/"
          // Straight from typing to the first result: it opens, and the arrows go on from there.
          onPick={() => {
            const first = loaded?.rows[0];
            if (first === undefined || stale) return;
            onSelectTicket(first.id);
            tableRef.current?.focus();
          }}
          className="w-full max-w-[520px]"
          testId="repair.desk.board.search"
        />
      </PageHeader>

      {/* The servisan opens beside the table when both fit: a 400 px pane next to a table folded
          down to number, customer and status (about 530 px), which a 1024 px window with the
          sidebar down to icons holds. Narrower than that (the sidebar opened wide on a small
          screen), it covers the whole board rather than half of it, so no column is cut. */}
      <div className="flex min-h-0 flex-1 flex-col @container">
        <div
          className={
            selectedTicketId === null
              ? 'relative grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)]'
              : 'relative grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] @[960px]:grid-cols-[minmax(0,1fr)_clamp(400px,38%,600px)]'
          }
        >
          <div className="flex min-h-0 min-w-0 flex-col">
            <div className="px-6">
              {searching ? (
                <p
                  role="status"
                  className="flex h-10 items-center text-body text-text-muted"
                  data-testid="repair.desk.board.results"
                >
                  {loaded === null || stale
                    ? ''
                    : tn('repair.desk.results', { count: loaded.total })}
                </p>
              ) : (
                <Tabs
                  items={boardViews(can, waitingApprovals).map((value) => {
                    const label = boardViewLabel(value, {
                      approvals: waitingApprovals,
                      pickup: loaded?.pickup ?? null,
                    });
                    return { value, label: tn(label.key, { count: label.count }) };
                  })}
                  value={view}
                  onChange={(next) =>
                    update({
                      view: next,
                      // A status the new queue cannot hold is dropped, so the filter never hides
                      // everything for a reason the toolbar no longer shows.
                      facets: facetsFor(next, facets),
                      sort: next === 'cancelled' && sort?.column === 'received' ? null : sort,
                    })
                  }
                  label={tn('repair.board.title')}
                  testId="repair.desk.board.views"
                />
              )}
            </div>
            {toolbar}
            <DataTable
              rows={loaded?.rows ?? []}
              columns={columns}
              getRowId={(row) => row.id}
              hiddenColumns={hiddenColumns}
              selectedId={selectedTicketId}
              onSelect={(row) => {
                if (!stale) onSelectTicket(row.id);
              }}
              // Enter (or a double click) moves the keyboard into the open servisan.
              onActivate={() => {
                if (!stale) paneRef.current?.querySelector<HTMLElement>('section')?.focus();
              }}
              bodyRef={tableRef}
              // The query sorts, across every page; the headers only choose the order.
              manualSorting
              sorting={sort === null ? [] : [{ id: sort.column, desc: sort.descending }]}
              onSortingChange={(next) => {
                const first = next[0];
                update({
                  sort:
                    first === undefined
                      ? null
                      : { column: first.id as SortableColumn, descending: first.desc },
                });
              }}
              scrollKey={scope}
              loading={query.status === 'loading'}
              empty={empty}
              label={tn('repair.board.title')}
              testId="repair.desk.board.table"
            />
            {loaded === null || loaded.total === 0 ? null : (
              <Pagination
                page={Math.min(page, pageCount)}
                pageSize={pageSize}
                total={loaded.total}
                pageSizes={PAGE_SIZES}
                onPageChange={(next) => onFiltersChange({ ...state, page: next })}
                onPageSizeChange={(size) => update({ pageSize: size })}
                labels={{
                  range: (from, to, total) =>
                    tn('repair.desk.table.range', {
                      from: formatNumber(from),
                      to: formatNumber(to),
                      total: formatNumber(total),
                    }),
                  perPage: (size) => tn('repair.desk.table.perPage', { size }),
                  previous: tn('repair.desk.table.previous'),
                  next: tn('repair.desk.table.next'),
                  page: (n) => tn('repair.desk.table.page', { page: n }),
                  label: tn('repair.desk.table.pages'),
                }}
                testId="repair.desk.board.pagination"
              />
            )}
          </div>
          {selectedTicketId === null ? null : (
            <div
              ref={paneRef}
              className="absolute inset-0 z-10 flex animate-pane-in flex-col @[960px]:static"
            >
              <TicketPane
                // A fresh pane per ticket: nothing said about the last one carries over.
                key={selectedTicketId}
                ticketId={selectedTicketId}
                justOpened={selectedTicketId === justOpenedTicketId}
                now={clock}
                onClose={closePane}
                onOpenSyncStatus={onOpenSyncStatus}
                onStartClaim={onStartClaim}
                onOpenTicket={onSelectTicket}
                printFirst={openedTicketId === selectedTicketId}
                onPrintOffered={onOpenedShown}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Columns the table cannot do without: which servisan it is, and whose. */
const LOCKED_COLUMNS: readonly string[] = ['number', 'customer'];

function dayRangeText(range: DayRangeValue): string {
  const day = (value: string): string => {
    const [year, month, date] = value.split('-').map(Number) as [number, number, number];
    return formatDate(new Date(year, month - 1, date).getTime());
  };
  if (range.from !== null && range.to !== null) {
    return tn('repair.desk.filter.range', { from: day(range.from), to: day(range.to) });
  }
  return range.from !== null
    ? tn('repair.desk.filter.since', { from: day(range.from) })
    : tn('repair.desk.filter.until', { to: day(range.to!) });
}

type Column = ColumnDef<TicketSummaryRow, unknown>;

function boardColumns({
  statuses,
  showCancel,
  searching,
  waited,
  approvalWaiting,
}: {
  readonly statuses: EntitySyncStatuses;
  readonly searching: boolean;
  /** A request on it waits on an owner's answer (one this user asked, or may give). */
  readonly approvalWaiting: (row: TicketSummaryRow) => boolean;
  /** Days a finished phone has waited past the store's limit; null when it is not flagged. */
  readonly waited: (row: TicketSummaryRow) => number | null;
  /** The owners' cancelled view: who cancelled and why, and the fee charged. */
  readonly showCancel: boolean;
}): Column[] {
  const device = (row: TicketSummaryRow): string =>
    [row.deviceBrand, row.deviceModel].filter((s) => s !== '').join(' ');
  return [
    {
      id: 'number',
      accessorFn: (row) => row.ticketNumber,
      header: tn('repair.desk.col.number'),
      meta: { track: '96px' },
      cell: ({ row: { original: row } }) => {
        const pending = statusesFor(statuses, row.id).includes('local');
        return (
          <span className="flex items-center gap-1">
            <span className="tabular text-small font-semibold text-text">{row.ticketNumber}</span>
            {pending ? (
              <Tooltip label={t('sync.chip.pending')}>
                <span role="img" aria-label={t('sync.chip.pending')} className="text-text-muted">
                  <CloudOff size={14} aria-hidden />
                </span>
              </Tooltip>
            ) : null}
          </span>
        );
      },
    },
    {
      id: 'customer',
      accessorFn: (row) => row.customerName,
      header: tn('repair.desk.col.customer'),
      // Names are encrypted on the device, so only search results (decrypted) sort by name.
      enableSorting: searching,
      // The name is how the counter finds a servisan, so it gets as much room as the device and a
      // minimum that holds a typical full name.
      meta: { track: 'minmax(168px, 2fr)' },
      // With the device column folded away (a narrow window, or the pane open) the device takes the
      // phone number's place under the name.
      cell: ({ row: { original: row }, table }) => (
        <TwoLines
          first={row.customerName}
          second={
            table.getColumn('device')?.getIsVisible() === false
              ? device(row)
              : row.customerPhone === null
                ? ''
                : formatPhone(row.customerPhone)
          }
          strong
        />
      ),
    },
    {
      id: 'device',
      accessorFn: (row) => device(row),
      header: tn('repair.desk.col.device'),
      meta: { track: 'minmax(160px, 2fr)', fold: 3 },
      enableSorting: false,
      cell: ({ row: { original: row } }) => (
        <TwoLines
          first={device(row)}
          second={showCancel ? (row.outcomeNote ?? '') : row.complaint}
        />
      ),
    },
    {
      id: 'technician',
      accessorFn: (row) => (showCancel ? row.cancelledByName : row.technicianName) ?? '',
      header: tn(showCancel ? 'repair.desk.col.cancelledBy' : 'repair.desk.col.technician'),
      meta: { track: 'minmax(132px, 1fr)', fold: 2 },
      enableSorting: false,
      cell: ({ row: { original: row } }) =>
        showCancel ? (
          <span className="text-body text-text">{row.cancelledByName ?? '–'}</span>
        ) : row.technicianName === null ? (
          <span className="whitespace-nowrap text-body text-text-muted">
            {tn('repair.ticket.unassigned')}
          </span>
        ) : (
          <span className="text-body text-text">{row.technicianName}</span>
        ),
    },
    {
      id: 'status',
      accessorFn: (row) => statusLabel(ticketStatus(row)),
      header: tn('repair.desk.col.status'),
      meta: { track: 'minmax(196px, 1fr)' },
      enableSorting: false,
      cell: ({ row: { original: row } }) => {
        const feeChanged =
          showCancel &&
          row.cancelFee !== null &&
          row.cancelStandardFee !== null &&
          row.cancelFee !== row.cancelStandardFee;
        const days = waited(row);
        const warning = approvalWaiting(row)
          ? tn('repair.board.approvalWaiting')
          : row.pendingProposals > 0
            ? tn('repair.board.priceChangeWaiting')
            : feeChanged
              ? tn('repair.board.feeChanged')
              : days !== null
                ? tn('repair.board.waited', { days })
                : null;
        return (
          <span className="flex flex-col items-start gap-1">
            <StatusChip status={ticketStatus(row)} />
            {warning === null ? null : (
              <span className="flex items-center gap-1 text-small font-semibold text-warning">
                <TriangleAlert size={14} aria-hidden />
                {warning}
              </span>
            )}
          </span>
        );
      },
    },
    {
      id: 'received',
      accessorFn: (row) => (showCancel ? (row.cancelledAt ?? 0) : row.createdAt),
      header: tn(showCancel ? 'repair.desk.col.cancelledAt' : 'repair.desk.col.received'),
      meta: { track: '104px', fold: 1 },
      // The owners' cancelled view lists by when it was cancelled, a date the query only sorts newest first.
      enableSorting: !showCancel,
      cell: ({ row: { original: row } }) => {
        const at = showCancel ? row.cancelledAt : row.createdAt;
        return at === null ? null : <TwoLines first={formatDate(at)} second={formatTime(at)} />;
      },
    },
    {
      id: 'total',
      // A cancelled servisan costs the customer its fee, never the repair price.
      accessorFn: amountOwed,
      header: tn('repair.price.total'),
      // The last to give way: beside an open servisan, whose pane shows the price, on a small screen.
      meta: { track: '116px', align: 'end', fold: 4 },
      cell: ({ getValue }) => (
        <span className="tabular text-body font-semibold text-text">
          {formatMoney(getValue() as number)}
        </span>
      ),
    },
  ];
}

function TwoLines({
  first,
  second,
  strong = false,
}: {
  readonly first: string;
  readonly second: string;
  readonly strong?: boolean;
}): React.JSX.Element {
  return (
    <span className="block min-w-0">
      <OverflowText
        text={first}
        className={`text-body ${strong ? 'font-semibold' : ''} text-text`}
      />
      {second === '' ? null : <OverflowText text={second} className="text-small text-text-muted" />}
    </span>
  );
}
