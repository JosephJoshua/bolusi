// Belanja on the counter PC: this store's orders to suppliers, the ones still running first, with
// the selected order open beside them. A new order is F2; the suppliers are a dialog away.
import { formatDate } from '@bolusi/i18n';
import {
  Button,
  Chip,
  DataTable,
  OverflowText,
  PageHeader,
  StatePanel,
  Tabs,
  type ColumnDef,
} from '@bolusi/ui-web';
import { Plus, ShoppingCart, Store } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { QueryPanel, overlayOpen, typingInField } from '../../screen-kit/desktop/index.js';
import { tp, type PurchasingKey } from '../i18n.js';
import { STAGE_CHIP } from '../order-form.js';
import { ORDER_FILTERS, type OrderFilter, type OrderRow } from '../queries.js';
import { loadOrderPages, usePurchasingQuery } from '../runtime.js';
import { OrderDialog, SuppliersDialog } from './dialogs.js';
import { OrderPane } from './OrderPane.js';
import { STAGE_ICON } from './stage.js';

const PAGE = 100;

export interface OrdersPageProps {
  /** Running or done, owned by the app so it survives a trip to another page. */
  readonly filter: OrderFilter;
  readonly onFilterChange: (filter: OrderFilter) => void;
}

export function OrdersPage({ filter, onFilterChange }: OrdersPageProps): React.JSX.Element {
  const [pages, setPages] = useState(1);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [task, setTask] = useState<'none' | 'new' | 'suppliers'>('none');
  const [notice, setNotice] = useState<PurchasingKey | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const testId = 'purchasing.desk';

  const query = usePurchasingQuery(
    async (rt) => {
      return { filter, ...(await loadOrderPages(rt, filter, pages, PAGE)) };
    },
    `desk.orders:${filter}:${String(pages)}:${String(reloadNonce)}`,
  );
  const loaded = query.status === 'ready' ? query.data : null;
  // Offline with the orders not on this PC: nothing to add to or pick from.
  const notHere = query.status === 'error' && query.code === 'NOT_ON_DEVICE';
  const stale = loaded !== null && loaded.filter !== filter;

  const closePane = (): void => {
    setSelectedId(null);
    setNotice(null);
    tableRef.current?.focus();
  };
  const open = (orderId: string): void => {
    setNotice(null);
    setSelectedId(orderId);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (overlayOpen()) return;
      if (event.key === 'F2') {
        event.preventDefault();
        if (!notHere) setTask('new');
      } else if (event.key === 'Escape' && selectedId !== null && !typingInField(event.target)) {
        closePane();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [selectedId, notHere]);

  const columns = useMemo(orderColumns, []);
  const empty =
    query.status === 'unauthorized' || query.status === 'error' ? (
      <QueryPanel query={query} onRetry={() => setReloadNonce((n) => n + 1)}>
        {() => null}
      </QueryPanel>
    ) : filter === 'done' ? (
      <StatePanel icon={ShoppingCart} title={tp('purchasing.list.emptyDone')} />
    ) : (
      <StatePanel
        icon={ShoppingCart}
        title={tp('purchasing.list.emptyOpen')}
        hint={tp('purchasing.desk.emptyHint')}
        action={
          <Button
            label={tp('purchasing.list.new')}
            variant="primary"
            icon={Plus}
            onClick={() => setTask('new')}
          />
        }
      />
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid={`${testId}.orders`}>
      <PageHeader
        title={tp('purchasing.list.title')}
        actions={
          <>
            <Button
              label={tp('purchasing.supplier.listTitle')}
              icon={Store}
              onClick={() => setTask('suppliers')}
              disabled={notHere}
              data-testid={`${testId}.openSuppliers`}
            />
            <Button
              label={tp('purchasing.list.new')}
              variant="primary"
              icon={Plus}
              shortcut="F2"
              onClick={() => setTask('new')}
              disabled={notHere}
              data-testid={`${testId}.new`}
            />
          </>
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
              <Tabs<OrderFilter>
                items={ORDER_FILTERS.map((value) => ({
                  value,
                  label: tp(value === 'open' ? 'purchasing.list.open' : 'purchasing.list.done'),
                }))}
                value={filter}
                onChange={(next) => {
                  setPages(1);
                  onFilterChange(next);
                }}
                label={tp('purchasing.list.title')}
                testId={`${testId}.views`}
              />
            </div>
            <DataTable
              rows={stale ? [] : (loaded?.rows ?? [])}
              columns={columns}
              getRowId={(row) => row.id}
              selectedId={selectedId}
              onSelect={(row) => open(row.id)}
              onActivate={() => paneRef.current?.querySelector<HTMLElement>('section')?.focus()}
              bodyRef={tableRef}
              // Pages load as the table scrolls, so the headers do not sort what is loaded so far.
              sortable={false}
              scrollKey={filter}
              onEndReached={() => {
                if (loaded?.hasMore === true && !stale) setPages((n) => n + 1);
              }}
              loading={query.status === 'loading'}
              empty={empty}
              label={tp('purchasing.list.title')}
              testId={`${testId}.table`}
            />
          </div>
          {selectedId === null ? null : (
            <div
              ref={paneRef}
              className="absolute inset-y-0 right-0 z-10 flex w-[min(440px,100%)] animate-pane-in flex-col shadow-2xl @[1080px]:static @[1080px]:w-auto @[1080px]:shadow-none"
            >
              <OrderPane
                // A fresh pane per order: nothing said about the last one carries over.
                key={selectedId}
                orderId={selectedId}
                onClose={closePane}
                notice={notice}
                onClearNotice={() => setNotice(null)}
              />
            </div>
          )}
        </div>
      </div>
      {task === 'new' ? (
        <OrderDialog
          onClose={() => setTask('none')}
          onDone={(orderId, placed) => {
            setTask('none');
            // A new order is a running one: show it there, open beside the list.
            onFilterChange('open');
            setSelectedId(orderId);
            setNotice(placed ? 'purchasing.done.placed' : 'purchasing.done.drafted');
          }}
        />
      ) : task === 'suppliers' ? (
        <SuppliersDialog onClose={() => setTask('none')} />
      ) : null}
    </div>
  );
}

type Column = ColumnDef<OrderRow, unknown>;

function orderColumns(): Column[] {
  return [
    {
      id: 'supplier',
      accessorFn: (row) => row.supplierName,
      header: tp('purchasing.desk.col.supplier'),
      meta: { track: 'minmax(220px, 3fr)' },
      cell: ({ row: { original: row } }) => (
        <OverflowText text={row.supplierName} className="text-body font-semibold text-text" />
      ),
    },
    {
      id: 'order',
      accessorFn: (row) => row.orderNumber,
      header: tp('purchasing.desk.col.order'),
      meta: { track: 'minmax(150px, 1fr)', fold: 1 },
      cell: ({ row: { original: row } }) => (
        <span className="flex min-w-0 flex-col">
          <span className="tabular whitespace-nowrap text-body text-text">{row.orderNumber}</span>
          <span className="tabular text-small text-text-muted">
            {formatDate(row.orderedAt ?? row.createdAt)}
          </span>
        </span>
      ),
    },
    {
      id: 'parts',
      accessorFn: (row) => row.lineCount,
      header: tp('purchasing.desk.col.parts'),
      meta: { track: 'minmax(180px, 2fr)', fold: 2 },
      cell: ({ row: { original: row } }) => (
        <span className="text-body text-text">
          {[
            tp('purchasing.list.parts', { count: row.lineCount }),
            row.receivedQty > 0
              ? tp('purchasing.list.progress', {
                  received: row.receivedQty,
                  ordered: row.orderedQty,
                })
              : null,
          ]
            .filter((part) => part !== null)
            .join(' · ')}
        </span>
      ),
    },
    {
      id: 'stage',
      accessorFn: (row) => row.stage,
      header: tp('purchasing.desk.col.stage'),
      meta: { track: 'minmax(170px, auto)' },
      cell: ({ row: { original: row } }) => {
        const chip = STAGE_CHIP[row.stage];
        return (
          <span data-testid={`purchasing.desk.table.stage.${row.id}`}>
            <Chip
              label={tp(`purchasing.stage.${row.stage}`)}
              icon={STAGE_ICON[chip.icon]}
              tone={chip.tone}
            />
          </span>
        );
      },
    },
  ];
}
