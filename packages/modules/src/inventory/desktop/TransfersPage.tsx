// Kiriman on the counter PC: parts sent between this store and the business's others, the open ones
// first, with the selected transfer open beside them. Sending is F2, for whoever may send.
import { useDoneNote } from '../../screen-kit/index.js';
import { formatDate, t } from '@bolusi/i18n';
import {
  Button,
  Chip,
  DataTable,
  OverflowText,
  PageHeader,
  StatePanel,
  Tabs,
  type ColumnDef,
  type Crumb,
} from '@bolusi/ui-web';
import { ArrowLeftRight, Send } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { QueryPanel, overlayOpen, typingInField } from '../../screen-kit/desktop/index.js';
import { INVENTORY_PERMISSION } from '../constants.js';
import { ti, type InventoryKey } from '../i18n.js';
import { useInventoryQuery, useInventoryRuntime } from '../runtime.js';
import {
  TRANSFER_STAGE_CHIP,
  otherStoreText,
  transferProgress,
  type StoreChoice,
} from '../transfers/form.js';
import { TRANSFER_FILTERS, type TransferFilter, type TransferRow } from '../transfers/queries.js';
import { useStores } from '../transfers/stores.js';
import { STAGE_ICON } from './stage.js';
import { SendDialog } from './transfer-dialogs.js';
import { TransferPane } from './TransferPane.js';

export interface TransfersPageProps {
  /** Where the page sits in its place (Barang › Kiriman). */
  readonly place: { readonly title: string; readonly trail: readonly Crumb[] };
  /** Open or all, owned by the app so it survives a trip to another page. */
  readonly filter: TransferFilter;
  readonly onFilterChange: (filter: TransferFilter) => void;
}

export function TransfersPage({
  place,
  filter,
  onFilterChange,
}: TransfersPageProps): React.JSX.Element {
  const runtime = useInventoryRuntime();
  const stores = useStores();
  const [reloadNonce, setReloadNonce] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const { note: notice, say: setNotice } = useDoneNote<InventoryKey>((key) => ti(key));
  const tableRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const sends = runtime.hasPermission(INVENTORY_PERMISSION.transfer);
  const testId = 'inventory.desk.transfers';

  const query = useInventoryQuery(
    async (rt) => ({ filter, rows: (await rt.query('listTransfers', { filter })).rows }),
    `desk.transfers:${filter}:${String(reloadNonce)}`,
  );
  const loaded = query.status === 'ready' ? query.data : null;
  const stale = loaded !== null && loaded.filter !== filter;

  const closePane = (): void => {
    setSelectedId(null);
    setNotice(null);
    tableRef.current?.focus();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (overlayOpen()) return;
      if (event.key === 'F2' && sends) {
        event.preventDefault();
        setSending(true);
      } else if (event.key === 'Escape' && selectedId !== null && !typingInField(event.target)) {
        closePane();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [selectedId, sends]);

  const columns = useMemo(() => transferColumns(stores), [stores]);
  const empty =
    query.status === 'unauthorized' || query.status === 'error' ? (
      <QueryPanel query={query} onRetry={() => setReloadNonce((n) => n + 1)}>
        {() => null}
      </QueryPanel>
    ) : (
      <StatePanel
        icon={ArrowLeftRight}
        title={ti(
          filter === 'open'
            ? 'inventory.transfer.list.emptyOpen'
            : 'inventory.transfer.list.emptyAll',
        )}
        action={
          sends ? (
            <Button
              label={ti('inventory.transfer.list.new')}
              variant="primary"
              icon={Send}
              onClick={() => setSending(true)}
            />
          ) : undefined
        }
      />
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid={testId}>
      <PageHeader
        title={place.title}
        trail={place.trail}
        trailLabel={t('core.nav.trail')}
        actions={
          sends ? (
            <Button
              label={ti('inventory.transfer.list.new')}
              // One filled button in view: with an open pane, its next step is the primary.
              variant={selectedId === null ? 'primary' : 'secondary'}
              icon={Send}
              shortcut="F2"
              onClick={() => setSending(true)}
              data-testid={`${testId}.new`}
            />
          ) : undefined
        }
      />

      <div className="flex min-h-0 flex-1 flex-col @container">
        <div
          className={
            selectedId === null
              ? 'relative grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)]'
              : 'relative grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] @[1080px]:grid-cols-[minmax(0,1fr)_clamp(400px,38%,560px)]'
          }
        >
          <div className="flex min-h-0 min-w-0 flex-col">
            <div className="px-6">
              <Tabs<TransferFilter>
                items={TRANSFER_FILTERS.map((value) => ({
                  value,
                  label: ti(
                    value === 'open'
                      ? 'inventory.transfer.list.open'
                      : 'inventory.transfer.list.all',
                  ),
                }))}
                value={filter}
                onChange={onFilterChange}
                label={place.title}
                testId={`${testId}.views`}
              />
            </div>
            <DataTable
              rows={stale ? [] : (loaded?.rows ?? [])}
              columns={columns}
              getRowId={(row) => row.id}
              selectedId={selectedId}
              onSelect={(row) => {
                setNotice(null);
                setSelectedId(row.id);
              }}
              onActivate={() => paneRef.current?.querySelector<HTMLElement>('section')?.focus()}
              bodyRef={tableRef}
              scrollKey={filter}
              loading={query.status === 'loading'}
              empty={empty}
              label={place.title}
              testId={`${testId}.table`}
            />
          </div>
          {selectedId === null ? null : (
            <div
              ref={paneRef}
              className="absolute inset-y-0 right-0 z-10 flex w-[min(440px,100%)] animate-pane-in flex-col shadow-2xl @[1080px]:static @[1080px]:w-auto @[1080px]:shadow-none"
            >
              <TransferPane
                // A fresh pane per transfer: nothing said about the last one carries over.
                key={selectedId}
                transferId={selectedId}
                onClose={closePane}
                notice={notice}
                onClearNotice={() => setNotice(null)}
              />
            </div>
          )}
        </div>
      </div>
      {sending ? (
        <SendDialog
          onClose={() => setSending(false)}
          onDone={(transferId) => {
            setSending(false);
            // A new transfer is an open one: show it there, open beside the list.
            onFilterChange('open');
            setSelectedId(transferId);
            setNotice('inventory.transfer.done.sent');
          }}
        />
      ) : null}
    </div>
  );
}

type Column = ColumnDef<TransferRow, unknown>;

function transferColumns(stores: readonly StoreChoice[]): Column[] {
  return [
    {
      id: 'store',
      accessorFn: (row) => otherStoreText(row, stores),
      header: ti('inventory.transfer.desk.col.store'),
      meta: { track: 'minmax(220px, 3fr)' },
      cell: ({ row: { original: row } }) => (
        <OverflowText
          text={otherStoreText(row, stores)}
          className="text-body font-semibold text-text"
        />
      ),
    },
    {
      id: 'number',
      accessorFn: (row) => row.sentAt,
      header: ti('inventory.transfer.desk.col.number'),
      meta: { track: 'minmax(150px, 1fr)', fold: 1 },
      cell: ({ row: { original: row } }) => (
        <span className="flex min-w-0 flex-col">
          <span className="tabular whitespace-nowrap text-body text-text">
            {row.transferNumber}
          </span>
          <span className="tabular text-small text-text-muted">{formatDate(row.sentAt)}</span>
        </span>
      ),
    },
    {
      id: 'progress',
      accessorFn: (row) => row.arrivedQty,
      header: ti('inventory.transfer.desk.col.progress'),
      meta: { track: 'minmax(200px, 2fr)', fold: 2 },
      cell: ({ row: { original: row } }) => (
        <span className="text-body text-text">{transferProgress(row)}</span>
      ),
    },
    {
      id: 'stage',
      accessorFn: (row) => row.stage,
      header: ti('inventory.transfer.desk.col.stage'),
      meta: { track: 'minmax(170px, auto)' },
      cell: ({ row: { original: row } }) => {
        const chip = TRANSFER_STAGE_CHIP[row.stage];
        return (
          <span data-testid={`inventory.desk.transfers.table.stage.${row.id}`}>
            <Chip
              label={ti(`inventory.transfer.stage.${row.stage}`)}
              icon={STAGE_ICON[chip.icon]}
              tone={chip.tone}
            />
          </span>
        );
      },
    },
  ];
}
