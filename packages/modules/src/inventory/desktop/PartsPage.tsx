// The parts page on the counter PC: the business's items with this store's stock, search first,
// with the selected item open beside it. Typing ranks every item by fuzzy match on its name, codes,
// field values, tags and the phones it fits; without text the table runs by name and loads more as
// pages, so thousands of items stay quick. Headers sort by name or stock across every page. A USB scanner types a code and presses Enter, which
// opens the item it names. Owners get the "Stok minus" and archived views to sort out.
import { t } from '@bolusi/i18n';
import {
  Button,
  ChoiceList,
  FilterPopover,
  OverflowText,
  PageHeader,
  type Crumb,
  SearchField,
  StatePanel,
  Tabs,
  type ColumnDef,
} from '@bolusi/ui-web';
import { Package, Plus, Table2, Tags } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useSettledValue } from '../../screen-kit/index.js';
import { QueryPanel, overlayOpen, typingInField } from '../../screen-kit/desktop/index.js';
import { ChoiceFacet, TableFrame } from '../../screen-kit/desktop/table.js';
import { changeView, pageWindow, tableView, type TableView } from '../../screen-kit/table-view.js';
import { INVENTORY_PERMISSION } from '../constants.js';
import { ti } from '../i18n.js';
import { stockText } from '../labels.js';
import {
  EMPTY_VIEW_KEY,
  NO_FILTER,
  STOCK_VIEW_KEY,
  listInput,
  stockViews,
  useFilterChoices,
  type ListFilter,
} from '../list-filter.js';
import {
  NO_CATEGORY,
  type CategoryRow,
  type ItemRow,
  type ItemSort,
  type PartFilter,
} from '../queries.js';
import { useInventoryQuery, useInventoryRuntime } from '../runtime.js';
import { PartDialog } from './dialogs.js';
import { PartPane } from './PartPane.js';

const NO_CATEGORIES: readonly CategoryRow[] = [];
const ALL = 'all';

export interface PartsPageProps {
  /**
   * Where the page sits when its place has sections (Barang › Stok): the section's name as the
   * title and the place above it. Without it the page is its place's only page.
   */
  readonly place?: { readonly title: string; readonly trail: readonly Crumb[] } | undefined;
  /** The list's search, filter, sort and page, owned by the app so they survive a trip elsewhere. */
  readonly view: PartsView;
  readonly onViewChange: (view: PartsView) => void;
  /** The categories page, for whoever sets categories up. */
  readonly onOpenCategories?: (() => void) | undefined;
  /** The sheet for entering many items at once. */
  readonly onBulkAdd?: (() => void) | undefined;
}

/** The columns the parts table sorts by. */
export const PART_SORTABLE = ['name', 'stock'] as const;
export type PartsView = TableView<ListFilter, (typeof PART_SORTABLE)[number]>;

export function partsView(): PartsView {
  return tableView(NO_FILTER);
}

interface LoadedParts {
  /** The search and filter these rows answer, so rows from the last one are never acted on. */
  readonly scope: string;
  readonly rows: readonly ItemRow[];
  readonly total: number;
  readonly belowZero: number;
}

export function PartsPage({
  view,
  onViewChange,
  place,
  onOpenCategories,
  onBulkAdd,
}: PartsPageProps): React.JSX.Element {
  const runtime = useInventoryRuntime();
  const canManage = runtime.hasPermission(INVENTORY_PERMISSION.manageItems);
  const canSetUp = runtime.hasPermission(INVENTORY_PERMISSION.manageCategories);
  const filter = view.facets;
  const text = view.text;
  const [reloadNonce, setReloadNonce] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const typed = text.trim();
  const settled = useSettledValue(typed);
  const searchText = typed === '' ? '' : settled;
  // A view this person may no longer pick (their grants changed) reads as the usual one, in the
  // tabs and in the query alike.
  const views = stockViews(runtime.hasPermission);
  const shownFilter: ListFilter = views.includes(filter.stock)
    ? filter
    : { ...filter, stock: NO_FILTER.stock };
  const sort: ItemSort | null =
    view.sort === null ? null : `${view.sort.column}.${view.sort.descending ? 'desc' : 'asc'}`;
  const scope = JSON.stringify([searchText, shownFilter, sort, view.page, view.pageSize]);
  const update = (patch: Partial<ListFilter>): void =>
    onViewChange(changeView(view, { facets: { ...filter, ...patch } }));
  const choices = useFilterChoices(filter.categoryId);

  const categories = useInventoryQuery<readonly CategoryRow[]>(
    async (rt) => (await rt.query('listCategories', {})).rows,
    'desk.parts.categories',
  );
  const query = useInventoryQuery<LoadedParts>(
    async (rt) => {
      const { limit, offset, ...narrowing } = listInput(shownFilter, searchText, pageWindow(view));
      const [page, count] = await Promise.all([
        rt.query('listItems', { ...narrowing, limit, offset, sort }),
        rt.query('countItems', narrowing),
      ]);
      // Only those who sort out stock below zero see its count.
      const belowZero = canManage
        ? ((await rt.query('countBelowZero', {})).rows[0]?.count ?? 0)
        : 0;
      return { scope, rows: page.rows, total: count.rows[0]?.count ?? 0, belowZero };
    },
    `desk.parts:${scope}:${String(reloadNonce)}`,
  );
  const loaded = query.status === 'ready' ? query.data : null;
  const stale = loaded !== null && loaded.scope !== scope;
  const shownCategories = categories.status === 'ready' ? categories.data : NO_CATEGORIES;

  const closePane = (): void => {
    setSelectedId(null);
    setNotice(null);
    tableRef.current?.focus();
  };
  const open = (itemId: string): void => {
    setNotice(null);
    setSelectedId(itemId);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (overlayOpen()) return;
      if (event.key === 'F2' && canManage) {
        event.preventDefault();
        setAdding(true);
      } else if (
        (event.key === '/' || (event.key === 'k' && event.ctrlKey)) &&
        !typingInField(event.target)
      ) {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key === 'Escape' && selectedId !== null && !typingInField(event.target)) {
        closePane();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [canManage, selectedId]);

  /** A scanned or typed code that names one item opens it; otherwise the search shows near ones. */
  const openCode = async (): Promise<void> => {
    if (typed === '') return;
    const found = await runtime
      .query('findByCode', { code: typed })
      .then((page) => page.rows)
      .catch(() => []);
    if (found.length === 1 && found[0] !== undefined) open(found[0].id);
  };

  const columns = useMemo(() => {
    const names = new Map(shownCategories.map((c) => [c.id, c.name]));
    return partColumns((id) => names.get(id));
  }, [shownCategories]);
  const fieldsNarrowed =
    filter.tags.length > 0 || Object.values(filter.values).some((v) => v.length > 0);
  const resetFilters = (): void => update({ categoryId: null, tags: [], values: {} });
  const problem =
    query.status === 'unauthorized' || query.status === 'error' ? (
      <QueryPanel query={query} onRetry={() => setReloadNonce((n) => n + 1)}>
        {() => null}
      </QueryPanel>
    ) : undefined;
  const empty =
    shownFilter.stock !== 'active' ? (
      <StatePanel icon={Package} title={ti(EMPTY_VIEW_KEY[shownFilter.stock])} />
    ) : (
      <StatePanel
        icon={Package}
        title={t('core.status.empty')}
        hint={ti(EMPTY_VIEW_KEY.active)}
        action={
          canManage ? (
            <Button
              label={ti('inventory.action.add')}
              variant="primary"
              icon={Plus}
              onClick={() => setAdding(true)}
            />
          ) : undefined
        }
      />
    );

  const categoryOptions = [
    { value: ALL, label: ti('inventory.list.allCategories') },
    ...shownCategories.map((c) => ({ value: c.id, label: c.name })),
    { value: NO_CATEGORY, label: ti('inventory.list.noCategory') },
  ];
  const facetFilters = (
    <>
      {shownCategories.length === 0 ? null : (
        <FilterPopover
          label={ti('inventory.desk.filter.category')}
          summary={
            filter.categoryId === null
              ? null
              : (categoryOptions.find((o) => o.value === filter.categoryId)?.label ?? null)
          }
          clearLabel={t('core.table.filter.clear')}
          onClear={() => update({ categoryId: null, values: {} })}
          testId="inventory.desk.filter.category"
        >
          <ChoiceList
            options={categoryOptions}
            value={filter.categoryId ?? ALL}
            // Field values belong to a category's fields, so they go with it.
            onChange={(value) => update({ categoryId: value === ALL ? null : value, values: {} })}
            label={ti('inventory.desk.filter.category')}
            testId="inventory.desk.filter.category.list"
          />
        </FilterPopover>
      )}
      {choices.fields.map(({ field, values }) => (
        <ChoiceFacet
          key={field.id}
          label={field.label}
          options={values.map((value) => ({ value, label: value }))}
          selected={filter.values[field.id] ?? []}
          onChange={(selected) => update({ values: { ...filter.values, [field.id]: selected } })}
          testId={`inventory.desk.filter.field.${field.id}`}
        />
      ))}
      {choices.tags.length === 0 ? null : (
        <ChoiceFacet
          label={ti('inventory.filterStep.tags')}
          options={choices.tags.map((value) => ({ value, label: value }))}
          selected={filter.tags}
          onChange={(tags) => update({ tags })}
          testId="inventory.desk.filter.tags"
        />
      )}
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="inventory.desk.parts">
      <PageHeader
        title={place?.title ?? ti('inventory.list.title')}
        trail={place?.trail}
        trailLabel={t('core.nav.trail')}
        actions={
          canManage || canSetUp ? (
            <>
              {canSetUp && onOpenCategories !== undefined ? (
                <Button
                  label={ti('inventory.list.manageCategories')}
                  icon={Tags}
                  onClick={onOpenCategories}
                  data-testid="inventory.desk.categories"
                />
              ) : null}
              {canManage && onBulkAdd !== undefined ? (
                <Button
                  label={ti('inventory.bulk.open')}
                  icon={Table2}
                  onClick={onBulkAdd}
                  data-testid="inventory.desk.bulk"
                />
              ) : null}
              {canManage ? (
                <Button
                  label={ti('inventory.action.add')}
                  variant="primary"
                  icon={Plus}
                  shortcut="F2"
                  onClick={() => setAdding(true)}
                  data-testid="inventory.desk.add"
                />
              ) : null}
            </>
          ) : undefined
        }
      >
        <form
          className="w-full max-w-[520px]"
          onSubmit={(event) => {
            event.preventDefault();
            void openCode();
          }}
        >
          <SearchField
            ref={searchRef}
            value={text}
            onChange={(next) => onViewChange(changeView(view, { text: next }))}
            placeholder={ti('inventory.list.searchHint')}
            label={t('core.action.search')}
            clearLabel={ti('inventory.list.clearSearch')}
            shortcut="/"
            testId="inventory.desk.search"
          />
        </form>
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
            {/* The views stay while searching: a search looks within the view that is open. */}
            <div className="px-6">
              <Tabs<PartFilter>
                items={views.map((value) => ({
                  value,
                  label: ti(STOCK_VIEW_KEY[value]),
                  ...(value === 'belowZero' && (loaded?.belowZero ?? 0) > 0
                    ? { count: loaded!.belowZero }
                    : {}),
                }))}
                value={shownFilter.stock}
                onChange={(stock) => update({ stock })}
                label={ti('inventory.list.title')}
                testId="inventory.desk.views"
              />
            </div>
            <TableFrame
              view={view}
              onViewChange={onViewChange}
              rows={loaded?.rows ?? []}
              total={loaded?.total ?? null}
              stale={stale}
              loading={query.status === 'loading'}
              columns={columns}
              lockedColumns={LOCKED_COLUMNS}
              getRowId={(row) => row.id}
              filters={facetFilters}
              filtered={filter.categoryId !== null || fieldsNarrowed}
              onResetFilters={resetFilters}
              selectedId={selectedId}
              onSelect={(row) => open(row.id)}
              onActivate={() => paneRef.current?.querySelector<HTMLElement>('section')?.focus()}
              bodyRef={tableRef}
              empty={empty}
              problem={problem}
              label={ti('inventory.list.title')}
              testId="inventory.desk.table"
            />
          </div>
          {selectedId === null ? null : (
            <div
              ref={paneRef}
              className="absolute inset-y-0 right-0 z-10 flex w-[min(440px,100%)] animate-pane-in flex-col shadow-2xl @[1080px]:static @[1080px]:w-auto @[1080px]:shadow-none"
            >
              <PartPane
                // A fresh pane per item: nothing said about the last one carries over.
                key={selectedId}
                itemId={selectedId}
                onClose={closePane}
                notice={notice}
                onClearNotice={() => setNotice(null)}
              />
            </div>
          )}
        </div>
      </div>
      {adding ? (
        <PartDialog
          categoryId={
            filter.categoryId === null || filter.categoryId === NO_CATEGORY
              ? null
              : filter.categoryId
          }
          onClose={() => setAdding(false)}
          onDone={(itemId) => {
            setAdding(false);
            setSelectedId(itemId);
            setNotice(ti('inventory.done.added'));
          }}
        />
      ) : null}
    </div>
  );
}

/** Which item it is: never hidden. */
const LOCKED_COLUMNS: readonly string[] = ['name'];

type Column = ColumnDef<ItemRow, unknown>;

function partColumns(categoryName: (id: string) => string | undefined): Column[] {
  return [
    {
      id: 'name',
      accessorFn: (row) => row.name,
      header: ti('inventory.desk.col.name'),
      meta: { track: 'minmax(240px, 3fr)' },
      cell: ({ row: { original: row } }) => (
        <span className="flex min-w-0 flex-col">
          <OverflowText text={row.name} className="text-body font-semibold text-text" />
          {row.code === null ? null : (
            <OverflowText text={row.code} className="tabular text-small text-text-muted" />
          )}
        </span>
      ),
    },
    {
      id: 'category',
      accessorFn: (row) => (row.categoryId === null ? '' : (categoryName(row.categoryId) ?? '')),
      header: ti('inventory.desk.col.category'),
      meta: { track: 'minmax(120px, 1fr)', fold: 2 },
      enableSorting: false,
      cell: ({ getValue }) => (
        <span className="text-body text-text">{String(getValue()) || '–'}</span>
      ),
    },
    {
      id: 'fits',
      accessorFn: (row) => row.fits ?? '',
      header: ti('inventory.desk.col.fits'),
      meta: { track: 'minmax(240px, 2fr)', fold: 1 },
      enableSorting: false,
      cell: ({ row: { original: row } }) =>
        row.fits === null ? (
          <span className="text-body text-text-muted">–</span>
        ) : (
          <OverflowText text={row.fits} className="text-body text-text" />
        ),
    },
    {
      id: 'stock',
      accessorFn: (row) => row.onHand,
      header: ti('inventory.desk.col.stock'),
      meta: { track: '96px', align: 'end' },
      cell: ({ row: { original: row } }) => (
        <span
          className={
            row.onHand < 0
              ? 'tabular text-body font-semibold text-danger'
              : row.onHand === 0
                ? 'tabular text-body text-text-muted'
                : 'tabular text-body text-text'
          }
          data-testid={`inventory.desk.table.stock.${row.id}`}
        >
          {stockText(row.onHand)}
        </span>
      ),
    },
  ];
}
