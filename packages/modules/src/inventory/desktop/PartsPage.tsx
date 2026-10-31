// The parts page on the counter PC: the business's items with this store's stock, search first,
// with the selected item open beside it. Typing ranks every item by fuzzy match on its name, codes,
// field values, tags and the phones it fits; without text the table runs by name and loads more as
// it scrolls, so thousands of items stay quick. A USB scanner types a code and presses Enter, which
// opens the item it names. Owners get the "Stok minus" and archived views to sort out.
import { formatNumber, t } from '@bolusi/i18n';
import {
  Button,
  ChoiceList,
  DataTable,
  FilterPopover,
  OptionsFilter,
  OverflowText,
  PageHeader,
  SearchField,
  StatePanel,
  Tabs,
  type ColumnDef,
} from '@bolusi/ui-web';
import { FilterX, Package, Plus, SearchX } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useSettledValue } from '../../screen-kit/index.js';
import { QueryPanel, overlayOpen, typingInField } from '../../screen-kit/desktop/index.js';
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
import { NO_CATEGORY, type CategoryRow, type ItemRow, type PartFilter } from '../queries.js';
import { useInventoryQuery, useInventoryRuntime } from '../runtime.js';
import { PartDialog } from './dialogs.js';
import { PartPane } from './PartPane.js';

const PAGE = 100;
const NO_CATEGORIES: readonly CategoryRow[] = [];
const ALL = 'all';

export interface PartsPageProps {
  /** The list's filter, owned by the app so it survives a trip to another page. */
  readonly filter: ListFilter;
  readonly onFilterChange: (filter: ListFilter) => void;
}

interface LoadedParts {
  /** The search and filter these rows answer, so rows from the last one are never acted on. */
  readonly scope: string;
  readonly rows: readonly ItemRow[];
  readonly hasMore: boolean;
  readonly belowZero: number;
}

export function PartsPage({ filter, onFilterChange }: PartsPageProps): React.JSX.Element {
  const runtime = useInventoryRuntime();
  const canManage = runtime.hasPermission(INVENTORY_PERMISSION.manageItems);
  const [text, setText] = useState('');
  const [pages, setPages] = useState(1);
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
  const searching = searchText !== '';
  // A view this person may no longer pick (their grants changed) reads as the usual one, in the
  // tabs and in the query alike.
  const views = stockViews(runtime.hasPermission);
  const shownFilter: ListFilter = views.includes(filter.stock)
    ? filter
    : { ...filter, stock: NO_FILTER.stock };
  const scope = JSON.stringify([searchText, shownFilter]);
  const update = (patch: Partial<ListFilter>): void => {
    setPages(1);
    onFilterChange({ ...filter, ...patch });
  };
  const choices = useFilterChoices(filter.categoryId);

  const categories = useInventoryQuery<readonly CategoryRow[]>(
    async (rt) => (await rt.query('listCategories', {})).rows,
    'desk.parts.categories',
  );
  const query = useInventoryQuery<LoadedParts>(
    async (rt) => {
      // Every page scrolled to, re-read on each refresh so the live list stays whole.
      let rows: ItemRow[] = [];
      let next: string | null = '0';
      for (let n = 0; n < pages && next !== null; n += 1) {
        const page: { readonly rows: readonly ItemRow[]; readonly nextCursor: string | null } =
          await rt.query(
            'listItems',
            listInput(shownFilter, searchText, { limit: PAGE, offset: Number(next) }),
          );
        rows = [...rows, ...page.rows];
        next = page.nextCursor;
      }
      // Only those who sort out stock below zero see its count.
      const belowZero = canManage
        ? ((await rt.query('countBelowZero', {})).rows[0]?.count ?? 0)
        : 0;
      return { scope, rows, hasMore: next !== null, belowZero };
    },
    `desk.parts:${scope}:${String(pages)}:${String(reloadNonce)}`,
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
  const empty =
    query.status === 'unauthorized' || query.status === 'error' ? (
      <QueryPanel query={query} onRetry={() => setReloadNonce((n) => n + 1)}>
        {() => null}
      </QueryPanel>
    ) : filter.categoryId !== null || fieldsNarrowed ? (
      <StatePanel
        icon={FilterX}
        title={ti('inventory.list.noFilterMatches')}
        action={
          <Button
            label={ti('inventory.desk.filter.reset')}
            onClick={() => update({ categoryId: null, tags: [], values: {} })}
          />
        }
      />
    ) : searching ? (
      <StatePanel icon={SearchX} title={ti('inventory.list.noMatches')} />
    ) : shownFilter.stock !== 'active' ? (
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

  const filterLabels = {
    clear: ti('inventory.desk.filter.clear'),
    search: ti('inventory.desk.filter.search'),
    noMatches: ti('inventory.desk.filter.noMatches'),
  };
  const chosen = (count: number): string => ti('inventory.desk.filter.chosen', { count });
  const categoryOptions = [
    { value: ALL, label: ti('inventory.list.allCategories') },
    ...shownCategories.map((c) => ({ value: c.id, label: c.name })),
    { value: NO_CATEGORY, label: ti('inventory.list.noCategory') },
  ];
  const toolbar = (
    <div className="flex h-12 items-center gap-2 px-6" data-testid="inventory.desk.filters">
      {/* One row that scrolls sideways when the pane leaves it little room, never a second row. */}
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto pr-6 [mask-image:linear-gradient(to_right,black_calc(100%-32px),transparent)] [scrollbar-width:none]">
        {shownCategories.length === 0 ? null : (
          <FilterPopover
            label={ti('inventory.desk.filter.category')}
            summary={
              filter.categoryId === null
                ? null
                : (categoryOptions.find((o) => o.value === filter.categoryId)?.label ?? null)
            }
            clearLabel={filterLabels.clear}
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
          <OptionsFilter
            key={field.id}
            label={field.label}
            options={values.map((value) => ({ value, label: value }))}
            selected={filter.values[field.id] ?? []}
            onChange={(selected) => update({ values: { ...filter.values, [field.id]: selected } })}
            summarize={chosen}
            labels={filterLabels}
            testId={`inventory.desk.filter.field.${field.id}`}
          />
        ))}
        {choices.tags.length === 0 ? null : (
          <OptionsFilter
            label={ti('inventory.filterStep.tags')}
            options={choices.tags.map((value) => ({ value, label: value }))}
            selected={filter.tags}
            onChange={(tags) => update({ tags })}
            summarize={chosen}
            labels={filterLabels}
            testId="inventory.desk.filter.tags"
          />
        )}
        {filter.categoryId !== null || fieldsNarrowed ? (
          <Button
            variant="text"
            size="sm"
            label={ti('inventory.desk.filter.reset')}
            onClick={() => update({ categoryId: null, tags: [], values: {} })}
            data-testid="inventory.desk.filter.reset"
          />
        ) : null}
      </div>
      {searching ? (
        <p
          role="status"
          className="shrink-0 whitespace-nowrap text-body text-text-muted"
          data-testid="inventory.desk.results"
        >
          {loaded === null || stale
            ? ''
            : ti('inventory.desk.results', {
                count: `${formatNumber(loaded.rows.length)}${loaded.hasMore ? '+' : ''}`,
              })}
        </p>
      ) : null}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="inventory.desk.parts">
      <PageHeader
        title={ti('inventory.list.title')}
        actions={
          canManage ? (
            <Button
              label={ti('inventory.action.add')}
              variant="primary"
              icon={Plus}
              shortcut="F2"
              onClick={() => setAdding(true)}
              data-testid="inventory.desk.add"
            />
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
            onChange={(next) => {
              setPages(1);
              setText(next);
            }}
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
            {toolbar}
            <DataTable
              rows={loaded?.rows ?? []}
              columns={columns}
              getRowId={(row) => row.id}
              selectedId={selectedId}
              onSelect={(row) => {
                if (!stale) open(row.id);
              }}
              onActivate={() => {
                if (!stale) paneRef.current?.querySelector<HTMLElement>('section')?.focus();
              }}
              bodyRef={tableRef}
              // Pages load as the table scrolls, so the headers do not sort what is loaded so far.
              sortable={false}
              scrollKey={scope}
              onEndReached={() => {
                if (loaded?.hasMore === true && !stale) setPages((n) => n + 1);
              }}
              loading={query.status === 'loading'}
              empty={empty}
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
            <span className="tabular truncate text-small text-text-muted">{row.code}</span>
          )}
        </span>
      ),
    },
    {
      id: 'category',
      accessorFn: (row) => (row.categoryId === null ? '' : (categoryName(row.categoryId) ?? '')),
      header: ti('inventory.desk.col.category'),
      meta: { track: 'minmax(120px, 1fr)', fold: 2 },
      cell: ({ getValue }) => (
        <span className="text-body text-text">{String(getValue()) || '–'}</span>
      ),
    },
    {
      id: 'fits',
      accessorFn: (row) => row.fits ?? '',
      header: ti('inventory.desk.col.fits'),
      meta: { track: 'minmax(240px, 2fr)', fold: 1 },
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
