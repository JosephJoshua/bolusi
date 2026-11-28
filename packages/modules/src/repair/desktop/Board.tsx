// The counter's main page: the store's repairs as a table, search first, with the selected repair
// open beside it. Typing searches every ticket with the shared fuzzy index (names with Indonesian
// spelling tolerance, any phone format, ticket number, IMEI, model); with no text the table shows
// one queue. Either way the toolbar's filters narrow it, a header sorts it and the footer pages it.
// Keyboard first: "/" searches, arrows move, Enter moves into the open servisan, Esc closes it, F2
// starts intake.
import { formatDate, formatMoney, formatPhone, formatTime, t } from '@bolusi/i18n';
import {
  Button,
  FilterToggle,
  PageHeader,
  SearchField,
  StatePanel,
  Tabs,
  Tooltip,
  type ColumnDef,
} from '@bolusi/ui-web';
import { ClipboardList, CloudOff, Plus, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { statusesFor, useTick, type EntitySyncStatuses } from '../../screen-kit/index.js';
import { ChoiceFacet, DayFacet, TableFrame } from '../../screen-kit/desktop/table.js';
import { changeView, pageWindow, tableView, type TableView } from '../../screen-kit/table-view.js';
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
  UNASSIGNED,
  facetCount,
  facetsFor,
  matchesFacets,
  statusChoices,
  sortRows,
  tableFilter,
  tableSort,
  technicianChoice,
  SORTABLE_COLUMNS,
  type SortableColumn,
  type TicketFacets,
} from '../table.js';

import { QueryPanel, overlayOpen, typingInField } from '../../screen-kit/desktop/index.js';
import { StatusChip, TwoLines } from './parts.js';
import { TicketPane } from './TicketPane.js';

/** Search is ranked, so its best matches are the ones worth filtering and paging. */
const SEARCH_LIMIT = 500;

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

export interface BoardFilters extends TableView<TicketFacets, SortableColumn> {
  /** The queue shown while nothing is typed. */
  readonly view: BoardView;
}

/** A board on its usual queue, or on `view`, with nothing else narrowed. */
export function boardFilters(can: RepairAbilities, view?: BoardView): BoardFilters {
  return { ...tableView(NO_FACETS), view: view ?? defaultBoardView(can) };
}

/** The columns a remembered sort may name. */
export const BOARD_SORTABLE: readonly string[] = SORTABLE_COLUMNS;

/** The board moved to a queue with nothing typed or picked, keeping how the person set up the table. */
export function onQueue(filters: BoardFilters, view: BoardView): BoardFilters {
  return changeView(filters, { view, text: '', facets: NO_FACETS });
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
  /** Servisan with a waiting request this user sees (asked, or theirs to answer in Perlu dicek). */
  readonly approvalWaiting: ReadonlySet<string>;
  /** Phones waiting for pickup, for the tab and an empty active queue; null when not counted. */
  readonly pickup: number | null;
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
  const state = filters ?? boardFilters(can);
  const { view, text, facets, sort, page, pageSize } = state;
  /** Any change but a page turn starts again from the first page. */
  const update = (patch: Partial<BoardFilters>): void => onFiltersChange(changeView(state, patch));
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
        const { offset, limit } = pageWindow(state);
        rows = kept.slice(offset, offset + limit);
      } else {
        const filter = tableFilter(
          view,
          rt.userId,
          uncollectedBefore(uncollectedLimit, readAt),
          facets,
        );
        const [list, count] = await Promise.all([
          rt.query('listTickets', {
            filter,
            sort: tableSort(view, sort),
            ...pageWindow(state),
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
        approvalWaiting,
      };
    },
    `desk.board:${scope}:${String(reloadNonce)}:${String(hour)}`,
  );
  const loaded = query.status === 'ready' ? query.data : null;
  // The last page's rows stay up while the next one reads, so the table does not flash; they
  // cannot be opened meanwhile, and the count waits for the new rows.
  const stale = loaded !== null && loaded.scope !== scope;

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

  // Search and filters that leave nothing say so in the frame; a queue says what it lacks.
  const problem =
    query.status === 'unauthorized' || query.status === 'error' ? (
      <QueryPanel query={query} onRetry={() => setReloadNonce((n) => n + 1)}>
        {() => null}
      </QueryPanel>
    ) : undefined;
  const empty = (
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

  const statusOptions = statusChoices(searching ? 'search' : view);
  const now = clock();
  const facetFilters = (
    <>
      {statusOptions.length > 0 ? (
        <ChoiceFacet
          label={tn('repair.desk.filter.status')}
          options={statusOptions.map((status) => ({ value: status, label: statusLabel(status) }))}
          selected={facets.statuses}
          onChange={(statuses) => setFacets({ statuses: statuses as TicketStatus[] })}
          testId="repair.desk.filter.status"
        />
      ) : null}
      {searching || technicianChoice(view) ? (
        <ChoiceFacet
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
          testId="repair.desk.filter.technician"
        />
      ) : null}
      <DayFacet
        label={tn('repair.desk.filter.received')}
        value={facets.received}
        onChange={(received) => setFacets({ received })}
        now={now}
        testId="repair.desk.filter.received"
      />
      <ChoiceFacet
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
    </>
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
                  items={boardViews(can).map((value) => {
                    const label = boardViewLabel(value, {
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
            <TableFrame
              view={state}
              onViewChange={onFiltersChange}
              rows={loaded?.rows ?? []}
              total={loaded === null || stale ? (loaded?.total ?? null) : loaded.total}
              stale={stale}
              loading={query.status === 'loading'}
              columns={columns}
              lockedColumns={LOCKED_COLUMNS}
              getRowId={(row) => row.id}
              filters={facetFilters}
              filtered={facetCount(facets) > 0}
              onResetFilters={() => update({ facets: NO_FACETS })}
              selectedId={selectedTicketId}
              onSelect={(row) => onSelectTicket(row.id)}
              // Enter (or a double click) moves the keyboard into the open servisan.
              onActivate={() => paneRef.current?.querySelector<HTMLElement>('section')?.focus()}
              bodyRef={tableRef}
              empty={empty}
              problem={problem}
              label={tn('repair.board.title')}
              testId="repair.desk.board.table"
            />
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
