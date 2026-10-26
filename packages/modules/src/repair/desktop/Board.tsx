// The counter's main page: the store's repairs as a table, search first, with the selected repair
// open beside it. Typing searches every ticket with the shared fuzzy index (names with Indonesian
// spelling tolerance, any phone format, ticket number, IMEI, model); with no text the table shows
// one queue. Keyboard first: "/" searches, arrows move, Enter moves into the open servisan, Esc closes it, F2 starts intake.
import { formatDate, formatMoney, formatPhone, formatTime, t } from '@bolusi/i18n';
import {
  Button,
  DataTable,
  PageHeader,
  SearchField,
  StatePanel,
  Tabs,
  Tooltip,
  type ColumnDef,
} from '@bolusi/ui-web';
import { ClipboardList, CloudOff, Plus, SearchX, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { statusesFor, type EntitySyncStatuses } from '../../screen-kit/index.js';
import {
  boardFilter,
  boardSort,
  boardViews,
  defaultBoardView,
  repairAbilities,
  ticketStatus,
  type BoardView,
} from '../flows.js';
import type { TicketSummaryRow } from '../queries.js';
import { tn, type RepairKey } from '../i18n.js';
import { statusLabel } from '../labels.js';
import { useRepairQuery, useRepairRuntime } from '../runtime.js';

import { QueryPanel, StatusChip } from './parts.js';
import { TicketPane } from './TicketPane.js';

const PAGE = 50;
/** Search is ranked, so its best matches come first and one page is enough. */
const SEARCH_LIMIT = 100;

const VIEW_KEY: Readonly<Record<BoardView, RepairKey>> = {
  active: 'repair.board.view.active',
  mine: 'repair.board.view.mine',
  unassigned: 'repair.board.view.unassigned',
  pickup: 'repair.board.view.pickup',
  returned: 'repair.board.view.returned',
  cancelled: 'repair.board.view.cancelled',
};

export interface RepairBoardPageProps {
  /** The repair open beside the table, owned by the app so a new intake can open its ticket. */
  readonly selectedTicketId: string | null;
  readonly onSelectTicket: (ticketId: string | null) => void;
  readonly onNewIntake: () => void;
  readonly onOpenSyncStatus?: (() => void) | undefined;
  /** The queue and search text, owned by the app so they survive a trip to the intake page. Null
   * starts on the person's default queue. */
  readonly filters: BoardFilters | null;
  readonly onFiltersChange: (filters: BoardFilters) => void;
}

export interface BoardFilters {
  readonly view: BoardView;
  readonly text: string;
}

interface LoadedBoard {
  /** The queue or search these rows answer, so rows from the last one are never acted on. */
  readonly scope: string;
  readonly rows: readonly TicketSummaryRow[];
  readonly statuses: EntitySyncStatuses;
  readonly hasMore: boolean;
}

/** Whether a key press was meant for a field rather than for the page. */
function typingInField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function RepairBoardPage({
  selectedTicketId,
  onSelectTicket,
  onNewIntake,
  onOpenSyncStatus,
  filters,
  onFiltersChange,
}: RepairBoardPageProps): React.JSX.Element {
  const runtime = useRepairRuntime();
  const can = useMemo(() => repairAbilities(runtime.hasPermission), [runtime]);
  const view = filters?.view ?? defaultBoardView(can);
  const text = filters?.text ?? '';
  const setView = (next: BoardView): void => onFiltersChange({ view: next, text });
  const setText = (next: string): void => onFiltersChange({ view, text: next });
  const [pages, setPages] = useState(1);
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
  const scope = searching ? `q:${text.trim()}` : view;

  const query = useRepairQuery<LoadedBoard>(
    async (rt) => {
      let rows: TicketSummaryRow[] = [];
      let hasMore = false;
      if (searching) {
        rows = [
          ...(await rt.query('searchTickets', { text: text.trim(), limit: SEARCH_LIMIT })).rows,
        ];
      } else {
        // Every page scrolled to, re-read on each refresh so the live table stays whole.
        let cursor: string | null = null;
        for (let n = 0; n < pages; n += 1) {
          const page: {
            readonly rows: readonly TicketSummaryRow[];
            readonly nextCursor: string | null;
          } = await rt.query('listTickets', {
            filter: boardFilter(view, rt.userId),
            sort: boardSort(view),
            limit: PAGE,
            ...(cursor === null ? {} : { cursor }),
          });
          rows = [...rows, ...page.rows];
          cursor = page.nextCursor;
          if (cursor === null) break;
        }
        hasMore = cursor !== null;
      }
      const statuses = await rt.ticketSyncStatuses(rows.map((row) => row.id));
      return { scope, rows, statuses, hasMore };
    },
    `desk.board:${scope}:${String(pages)}:${String(reloadNonce)}`,
  );
  const loaded = query.status === 'ready' ? query.data : null;
  // The last queue's rows stay up while the next one reads, so the table does not flash; they
  // cannot be opened meanwhile, and the count waits for the new rows.
  const stale = loaded !== null && loaded.scope !== scope;

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Page shortcuts are off while a dialog or menu is up; it owns the keyboard, Escape included.
      // Listening in the capture phase sees the key before the dialog closes itself on it.
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null)
        return;
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
    () => boardColumns({ statuses: loaded?.statuses ?? {}, showCancel }),
    [loaded?.statuses, showCancel],
  );

  const empty =
    query.status === 'unauthorized' || query.status === 'error' ? (
      <QueryPanel query={query} onRetry={() => setReloadNonce((n) => n + 1)}>
        {() => null}
      </QueryPanel>
    ) : searching ? (
      <StatePanel icon={SearchX} title={tn('repair.board.noMatches')} />
    ) : (
      <StatePanel
        icon={ClipboardList}
        title={t('core.status.empty')}
        hint={tn('repair.board.emptyHint')}
      />
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="repair.desk.board">
      <PageHeader
        title={tn('repair.board.title')}
        actions={
          can.intake ? (
            <Button
              label={tn('repair.action.newIntake')}
              variant="primary"
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
          onChange={(next) => {
            setText(next);
            setPages(1);
          }}
          placeholder={tn('repair.board.searchHint')}
          label={t('core.action.search')}
          clearLabel={tn('repair.board.clearSearch')}
          shortcut="/"
          className="w-full max-w-[520px]"
          testId="repair.desk.board.search"
        />
      </PageHeader>

      {/* The servisan opens beside the table when both fit (the table's fixed columns need about
          650 px); on a narrower screen it slides over the table's right side instead. */}
      <div className="flex min-h-0 flex-1 flex-col @container">
        <div
          className={
            selectedTicketId === null
              ? 'relative grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)]'
              : 'relative grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] @[1048px]:grid-cols-[minmax(0,1fr)_clamp(400px,38%,600px)]'
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
                    : tn('repair.desk.results', { count: loaded.rows.length })}
                </p>
              ) : (
                <Tabs
                  items={boardViews(can).map((value) => ({ value, label: tn(VIEW_KEY[value]) }))}
                  value={view}
                  onChange={(next) => {
                    setView(next);
                    setPages(1);
                  }}
                  label={tn('repair.board.title')}
                  testId="repair.desk.board.views"
                />
              )}
            </div>
            <DataTable
              rows={loaded?.rows ?? []}
              columns={columns}
              getRowId={(row) => row.id}
              selectedId={selectedTicketId}
              onSelect={(row) => {
                if (!stale) onSelectTicket(row.id);
              }}
              // Enter (or a double click) moves the keyboard into the open servisan.
              onActivate={() => {
                if (!stale) paneRef.current?.querySelector<HTMLElement>('section')?.focus();
              }}
              bodyRef={tableRef}
              // The board loads page by page and the store's newest come first.
              sortable={false}
              onEndReached={
                !searching && loaded?.hasMore === true ? () => setPages((n) => n + 1) : undefined
              }
              loading={query.status === 'loading'}
              empty={empty}
              label={tn('repair.board.title')}
              testId="repair.desk.board.table"
            />
          </div>
          {selectedTicketId === null ? null : (
            <div
              ref={paneRef}
              className="absolute inset-y-0 right-0 z-10 flex w-[min(440px,100%)] flex-col shadow-2xl @[1048px]:static @[1048px]:w-auto @[1048px]:shadow-none"
            >
              <TicketPane
                // A fresh pane per ticket: nothing said about the last one carries over.
                key={selectedTicketId}
                ticketId={selectedTicketId}
                onClose={closePane}
                onOpenSyncStatus={onOpenSyncStatus}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type Column = ColumnDef<TicketSummaryRow, unknown>;

function boardColumns({
  statuses,
  showCancel,
}: {
  readonly statuses: EntitySyncStatuses;
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
      meta: { track: 'minmax(140px, 1.3fr)' },
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
      meta: { track: 'minmax(140px, 0.9fr)', fold: 2 },
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
      meta: { track: 'minmax(196px, 1.1fr)' },
      cell: ({ row: { original: row } }) => {
        const feeChanged =
          showCancel &&
          row.cancelFee !== null &&
          row.cancelStandardFee !== null &&
          row.cancelFee !== row.cancelStandardFee;
        const warning =
          row.pendingProposals > 0
            ? tn('repair.board.priceChangeWaiting')
            : feeChanged
              ? tn('repair.board.feeChanged')
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
      cell: ({ row: { original: row } }) => {
        const at = showCancel ? row.cancelledAt : row.createdAt;
        return at === null ? null : <TwoLines first={formatDate(at)} second={formatTime(at)} />;
      },
    },
    {
      id: 'total',
      // A cancelled servisan costs the customer its fee, never the repair price.
      accessorFn: (row) => (row.outcome === 'cancelled' ? (row.cancelFee ?? 0) : row.quoteTotal),
      header: tn('repair.price.total'),
      meta: { track: '116px', align: 'end' },
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
      <span
        className={`block truncate text-body ${strong ? 'font-semibold' : ''} text-text`}
        title={first}
      >
        {first}
      </span>
      {second === '' ? null : (
        <span className="block truncate text-small text-text-muted" title={second}>
          {second}
        </span>
      )}
    </span>
  );
}
