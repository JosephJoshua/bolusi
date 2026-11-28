// Belanja on the counter PC: this store's orders to suppliers, the ones still running first, with
// the selected order open beside them, and for whoever reads them the suppliers' bills. A new order
// (or bill, on Tagihan) is F2; the suppliers are a dialog away. Both tables search by supplier
// and number, filter by supplier and date, sort from their headers and page in the shared frame.
import { formatDate, t } from '@bolusi/i18n';
import {
  Button,
  Chip,
  OverflowText,
  PageHeader,
  SearchField,
  StatePanel,
  Tabs,
  type ColumnDef,
  type Crumb,
} from '@bolusi/ui-web';
import { Plus, ShoppingCart, Store } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { QueryPanel, overlayOpen, typingInField } from '../../screen-kit/desktop/index.js';
import { ChoiceFacet, DayFacet, TableFrame } from '../../screen-kit/desktop/table.js';
import { dayRangeBounds, type DayRange } from '../../screen-kit/days.js';
import {
  changeView,
  pageWindow,
  tableView,
  useTableView,
  type ColumnSort,
  type TableView,
} from '../../screen-kit/table-view.js';
import { opensBills } from '../constants.js';
import { tp, type PurchasingKey } from '../i18n.js';
import { STAGE_CHIP } from '../order-form.js';
import { ORDER_COLUMNS, ORDER_FILTERS, type OrderColumn, type OrderRow } from '../queries.js';
import { ORDER_STAGES, type OrderStage } from '../constants.js';
import { EMPTY_BILL, type BelanjaTab } from '../bills/bill-form.js';
import { BILL_COLUMNS, type BillColumn, type BillRow } from '../bills/queries.js';
import { usePurchasingQuery, usePurchasingRuntime } from '../runtime.js';
import { BillDialog, BillPane, billColumns } from './bills.js';
import { OrderDialog, SuppliersDialog } from './dialogs.js';
import { OrderPane } from './OrderPane.js';
import { STAGE_ICON } from './stage.js';

interface Facets {
  readonly suppliers: readonly string[];
  readonly stages: readonly OrderStage[];
  readonly on: DayRange | null;
}

const NO_FACETS: Facets = { suppliers: [], stages: [], on: null };

/** The stages each tab can hold, to offer as a filter. */
const OPEN_STAGES: readonly OrderStage[] = ['draft', 'ordered', 'partial'];
const DONE_STAGES = ORDER_STAGES.filter((stage) => !OPEN_STAGES.includes(stage));

const facetCount = (facets: Facets): number =>
  facets.suppliers.length + facets.stages.length + (facets.on === null ? 0 : 1);

/** A table's search, sort and page as its query reads them, with the facets as the query names them. */
function queryInput<C extends string>(view: TableView<Facets>) {
  const { from, before } =
    view.facets.on === null
      ? { from: undefined, before: undefined }
      : dayRangeBounds(view.facets.on);
  return {
    text: view.text.trim(),
    // The headers only offer the query's own columns, and a remembered sort is checked against them.
    sort: view.sort as ColumnSort<C> | null,
    supplierIds: [...view.facets.suppliers],
    ...pageWindow(view),
    from: from ?? null,
    before: before ?? null,
  };
}

export interface OrdersPageProps {
  /**
   * Where the page sits when its place has sections (Barang › Stok): the section's name as the
   * title and the place above it. Without it the page is its place's only page.
   */
  readonly place?: { readonly title: string; readonly trail: readonly Crumb[] } | undefined;
  /** Running, done or the bills, owned by the app so it survives a trip to another page. */
  readonly filter: BelanjaTab;
  readonly onFilterChange: (filter: BelanjaTab) => void;
}

export function OrdersPage({ filter, onFilterChange, place }: OrdersPageProps): React.JSX.Element {
  const [ordersView, setOrdersView] = useTableView(
    'purchasing.orders',
    () => tableView(NO_FACETS),
    {
      sortable: ORDER_COLUMNS,
    },
  );
  const [billsView, setBillsView] = useTableView('purchasing.bills', () => tableView(NO_FACETS), {
    sortable: BILL_COLUMNS,
  });
  const [reloadNonce, setReloadNonce] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [task, setTask] = useState<'none' | 'new' | 'newBill' | 'suppliers'>('none');
  const runtime = usePurchasingRuntime();
  const readsBills = opensBills(runtime);
  const bills = readsBills && filter === 'bills';
  const [notice, setNotice] = useState<PurchasingKey | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const testId = 'purchasing.desk';

  const view = bills ? billsView : ordersView;
  const setView = bills ? setBillsView : setOrdersView;
  const tab = filter === 'bills' ? 'open' : filter;
  const orderScope = JSON.stringify([tab, ordersView]);
  const query = usePurchasingQuery(
    async (rt) => {
      const { from, before, ...input } = queryInput<OrderColumn>(ordersView);
      const page = await rt.query('listOrders', {
        ...input,
        filter: tab,
        stages: [...ordersView.facets.stages],
        orderedFrom: from,
        orderedBefore: before,
      });
      return { scope: orderScope, rows: page.rows, total: page.total };
    },
    `desk.orders:${orderScope}:${String(reloadNonce)}`,
  );
  const billScope = JSON.stringify([bills, billsView]);
  const billQuery = usePurchasingQuery(
    async (rt) => {
      if (!bills) return { scope: billScope, rows: [] as readonly BillRow[], total: 0 };
      const { from, before, ...input } = queryInput<BillColumn>(billsView);
      const page = await rt.query('listBills', {
        ...input,
        filter: 'all',
        orderId: null,
        billedFrom: from,
        billedBefore: before,
      });
      return { scope: billScope, rows: page.rows, total: page.total };
    },
    `desk.bills:${billScope}:${String(reloadNonce)}`,
  );
  const loadedBills = billQuery.status === 'ready' ? billQuery.data : null;
  const loaded = query.status === 'ready' ? query.data : null;
  // Offline with the orders not on this PC: nothing to add to or pick from.
  const notHere = query.status === 'error' && query.code === 'NOT_ON_DEVICE';
  const shown = bills ? loadedBills : loaded;
  const stale = shown !== null && shown.scope !== (bills ? billScope : orderScope);
  const suppliers = usePurchasingQuery(
    async (rt) => (await rt.query('listSuppliers', { text: '', includeArchived: true })).rows,
    `desk.orders.suppliers:${String(reloadNonce)}`,
  );

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
        if (!notHere) setTask(bills ? 'newBill' : 'new');
      } else if (event.key === 'Escape' && selectedId !== null && !typingInField(event.target)) {
        closePane();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [selectedId, notHere, bills]);

  const columns = useMemo(orderColumns, []);
  const columnsOfBills = useMemo(billColumns, []);
  const shownQuery = bills ? billQuery : query;
  const problem =
    shownQuery.status === 'unauthorized' || shownQuery.status === 'error' ? (
      <QueryPanel query={shownQuery} onRetry={() => setReloadNonce((n) => n + 1)}>
        {() => null}
      </QueryPanel>
    ) : undefined;
  const facets = view.facets;
  const setFacets = (patch: Partial<Facets>): void =>
    setView(changeView(view, { facets: { ...facets, ...patch } }));
  const stageOptions = tab === 'open' ? OPEN_STAGES : DONE_STAGES;
  const facetFilters = (
    <>
      <ChoiceFacet
        label={tp('purchasing.desk.filter.supplier')}
        options={(suppliers.status === 'ready' ? suppliers.data : []).map((supplier) => ({
          value: supplier.id,
          label: supplier.name,
        }))}
        selected={facets.suppliers}
        onChange={(chosen) => setFacets({ suppliers: chosen })}
        testId={`${testId}.filter.supplier`}
      />
      {bills ? null : (
        <ChoiceFacet
          label={tp('purchasing.desk.filter.stage')}
          options={stageOptions.map((stage) => ({
            value: stage,
            label: tp(`purchasing.stage.${stage}`),
          }))}
          selected={facets.stages.filter((stage) => stageOptions.includes(stage))}
          onChange={(chosen) => setFacets({ stages: chosen as OrderStage[] })}
          testId={`${testId}.filter.stage`}
        />
      )}
      <DayFacet
        label={tp(bills ? 'purchasing.desk.filter.billed' : 'purchasing.desk.filter.ordered')}
        value={facets.on}
        onChange={(on) => setFacets({ on })}
        now={Date.now()}
        testId={`${testId}.filter.on`}
      />
    </>
  );
  const empty = bills ? (
    <StatePanel icon={ShoppingCart} title={tp('purchasing.bill.listEmpty')} />
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
        title={place?.title ?? tp('purchasing.list.title')}
        trail={place?.trail}
        trailLabel={t('core.nav.trail')}
        actions={
          <>
            <Button
              label={tp('purchasing.supplier.listTitle')}
              icon={Store}
              onClick={() => setTask('suppliers')}
              disabled={notHere}
              data-testid={`${testId}.openSuppliers`}
            />
            {bills ? (
              <Button
                label={tp('purchasing.bill.new')}
                variant={selectedId === null ? 'primary' : 'secondary'}
                icon={Plus}
                shortcut="F2"
                onClick={() => setTask('newBill')}
                data-testid={`${testId}.newBill`}
              />
            ) : (
              <Button
                label={tp('purchasing.list.new')}
                variant={selectedId === null ? 'primary' : 'secondary'}
                icon={Plus}
                shortcut="F2"
                onClick={() => setTask('new')}
                disabled={notHere}
                data-testid={`${testId}.new`}
              />
            )}
          </>
        }
      >
        <SearchField
          value={view.text}
          onChange={(text) => setView(changeView(view, { text }))}
          placeholder={tp('purchasing.desk.searchHint')}
          label={t('core.action.search')}
          clearLabel={t('core.table.clearSearch')}
          shortcut="/"
          className="w-full max-w-[520px]"
          testId={`${testId}.search`}
        />
      </PageHeader>

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
              <Tabs<BelanjaTab>
                items={[
                  ...ORDER_FILTERS.map((value) => ({
                    value,
                    label: tp(value === 'open' ? 'purchasing.list.open' : 'purchasing.list.done'),
                  })),
                  ...(readsBills
                    ? [{ value: 'bills' as const, label: tp('purchasing.bill.tab') }]
                    : []),
                ]}
                value={bills ? 'bills' : filter === 'bills' ? 'open' : filter}
                onChange={(next) => {
                  setSelectedId(null);
                  // A stage the other tab cannot hold is dropped, so no hidden filter empties it.
                  if (next !== 'bills') {
                    setOrdersView(
                      changeView(ordersView, { facets: { ...ordersView.facets, stages: [] } }),
                    );
                  }
                  onFilterChange(next);
                }}
                label={tp('purchasing.list.title')}
                testId={`${testId}.views`}
              />
            </div>
            {bills ? (
              <TableFrame
                key="bills"
                view={billsView}
                onViewChange={setBillsView}
                rows={loadedBills?.rows ?? []}
                total={loadedBills?.total ?? null}
                stale={stale}
                loading={billQuery.status === 'loading'}
                columns={columnsOfBills}
                lockedColumns={['supplier']}
                getRowId={(row) => row.id}
                filters={facetFilters}
                filtered={facetCount(billsView.facets) > 0}
                onResetFilters={() => setBillsView(changeView(billsView, { facets: NO_FACETS }))}
                selectedId={selectedId}
                onSelect={(row) => open(row.id)}
                onActivate={() => paneRef.current?.querySelector<HTMLElement>('section')?.focus()}
                bodyRef={tableRef}
                empty={empty}
                problem={problem}
                label={tp('purchasing.bill.tab')}
                testId={`${testId}.bills`}
              />
            ) : (
              <TableFrame
                key="orders"
                view={ordersView}
                onViewChange={setOrdersView}
                rows={loaded?.rows ?? []}
                total={loaded?.total ?? null}
                stale={stale}
                loading={query.status === 'loading'}
                columns={columns}
                lockedColumns={['supplier']}
                getRowId={(row) => row.id}
                filters={facetFilters}
                filtered={facetCount(ordersView.facets) > 0}
                onResetFilters={() => setOrdersView(changeView(ordersView, { facets: NO_FACETS }))}
                selectedId={selectedId}
                onSelect={(row) => open(row.id)}
                onActivate={() => paneRef.current?.querySelector<HTMLElement>('section')?.focus()}
                bodyRef={tableRef}
                empty={empty}
                problem={problem}
                label={tp('purchasing.list.title')}
                testId={`${testId}.table`}
              />
            )}
          </div>
          {selectedId === null ? null : (
            <div
              ref={paneRef}
              className="absolute inset-y-0 right-0 z-10 flex w-[min(440px,100%)] animate-pane-in flex-col shadow-2xl @[1080px]:static @[1080px]:w-auto @[1080px]:shadow-none"
            >
              {bills ? (
                <BillPane
                  key={selectedId}
                  billId={selectedId}
                  onClose={closePane}
                  notice={notice}
                  onClearNotice={() => setNotice(null)}
                />
              ) : (
                <OrderPane
                  // A fresh pane per order: nothing said about the last one carries over.
                  key={selectedId}
                  orderId={selectedId}
                  onClose={closePane}
                  onOpenBill={(billId) => {
                    setNotice(null);
                    onFilterChange('bills');
                    setSelectedId(billId);
                  }}
                  notice={notice}
                  onClearNotice={() => setNotice(null)}
                />
              )}
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
      ) : task === 'newBill' ? (
        <BillDialog
          start={EMPTY_BILL}
          onClose={() => setTask('none')}
          onDone={(billId) => {
            setTask('none');
            setSelectedId(billId);
            setNotice('purchasing.done.billRecorded');
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
      enableSorting: false,
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
