// Every PC list's table: a toolbar of filters with "Hapus semua filter" and the column chooser, the
// table itself sorted from its headers, and the footer that pages it. A page supplies its columns,
// its facets and the rows of the current page; this owns how they behave, so every list searches,
// filters, sorts, pages and hides columns the same way (servisan, Barang, Belanja, Kas…).
import { formatDate, formatNumber, t } from '@bolusi/i18n';
import { FuzzyIndex } from '@bolusi/core';
import {
  Button,
  ColumnsMenu,
  DataTable,
  DayRangeFilter,
  OptionsFilter,
  Pagination,
  StatePanel,
  type ColumnDef,
  type FilterOption,
} from '@bolusi/ui-web';
import { FilterX, SearchX } from 'lucide-react';
import { useEffect, type ReactNode, type RefObject } from 'react';

import { DAY_PRESETS, presetRange, type DayRange } from '../days.js';
import { changeView, pageCount, PAGE_SIZES, type TableView } from '../table-view.js';

/** Filter options matching typed text, best first, with the app's typo-tolerant search. */
export function fuzzyOptions(options: readonly FilterOption[], text: string): FilterOption[] {
  const index = new FuzzyIndex(
    options.map((option, rank) => ({ id: option.value, text: [option.label], rank: -rank })),
  );
  const byValue = new Map(options.map((option) => [option.value, option]));
  return index.search(text, options.length).map((hit) => byValue.get(hit.id)!);
}

const filterLabels = () => ({
  clear: t('core.table.filter.clear'),
  search: t('core.table.filter.search'),
  noMatches: t('core.table.filter.noMatches'),
});

/** A facet of several choices (status, supplier, category), searchable once it is long. */
export function ChoiceFacet({
  label,
  options,
  selected,
  onChange,
  testId,
}: {
  readonly label: string;
  readonly options: readonly FilterOption[];
  readonly selected: readonly string[];
  readonly onChange: (selected: string[]) => void;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  return (
    <OptionsFilter
      label={label}
      options={options}
      selected={selected}
      onChange={onChange}
      summarize={(count) => t('core.table.filter.chosen', { count })}
      labels={filterLabels()}
      match={fuzzyOptions}
      testId={testId}
    />
  );
}

function dayText(day: string): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return formatDate(new Date(year, month - 1, date).getTime());
}

/** A date facet (received, paid, ordered) with the usual quick choices. */
export function DayFacet({
  label,
  value,
  onChange,
  now,
  testId,
}: {
  readonly label: string;
  readonly value: DayRange | null;
  readonly onChange: (value: DayRange | null) => void;
  /** The clock the quick choices count from. */
  readonly now: number;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  return (
    <DayRangeFilter
      label={label}
      value={value}
      presets={DAY_PRESETS.map((preset) => ({
        key: preset,
        label: t(`core.table.filter.${preset}`),
        range: presetRange(preset, now),
      }))}
      onChange={onChange}
      summarize={(range) =>
        range.from !== null && range.to !== null
          ? t('core.table.filter.range', { from: dayText(range.from), to: dayText(range.to) })
          : range.from !== null
            ? t('core.table.filter.since', { from: dayText(range.from) })
            : t('core.table.filter.until', { to: dayText(range.to!) })
      }
      labels={{
        clear: t('core.table.filter.clear'),
        from: t('core.table.filter.from'),
        to: t('core.table.filter.to'),
      }}
      testId={testId}
    />
  );
}

/** What a list says when filters or a search leave nothing, with the way back. */
export function NarrowedEmpty({
  filtered,
  onReset,
}: {
  readonly filtered: boolean;
  readonly onReset: () => void;
}): React.JSX.Element {
  return filtered ? (
    <StatePanel
      icon={FilterX}
      title={t('core.table.filter.empty')}
      action={<Button label={t('core.table.filter.reset')} onClick={onReset} />}
    />
  ) : (
    <StatePanel icon={SearchX} title={t('core.table.noMatches')} />
  );
}

export interface TableFrameProps<T, V extends TableView<unknown>> {
  /** The list's view; a page may keep more in it (the servisan board's queue). */
  readonly view: V;
  readonly onViewChange: (view: V) => void;
  /** The rows on the view's page, sorted and narrowed already. */
  readonly rows: readonly T[];
  /** Every row the view lets through, on all pages; null while the first read runs. */
  readonly total: number | null;
  /**
   * True while rows from an earlier view are still shown as the next read runs: they stay up so
   * the table does not flash, but cannot be opened.
   */
  readonly stale?: boolean;
  readonly loading: boolean;
  readonly columns: readonly ColumnDef<T, unknown>[];
  /** Columns the table cannot do without (which record it is), never offered to hide. */
  readonly lockedColumns?: readonly string[];
  readonly getRowId: (row: T) => string;
  /** The facets in the toolbar, such as `ChoiceFacet`s and a `DayFacet`. */
  readonly filters?: ReactNode;
  /** Whether any facet narrows the list (shows "Hapus semua filter"). */
  readonly filtered: boolean;
  /** The view with every facet cleared. */
  readonly onResetFilters: () => void;
  readonly selectedId: string | null;
  readonly onSelect: (row: T) => void;
  readonly onActivate?: ((row: T) => void) | undefined;
  /** The list's own empty state, when nothing narrows it. */
  readonly empty: ReactNode;
  /** Shown instead of the empty state while the read failed or is not allowed. */
  readonly problem?: ReactNode;
  readonly rowHeight?: number;
  readonly label: string;
  readonly testId: string;
  readonly bodyRef?: RefObject<HTMLDivElement | null> | undefined;
}

export function TableFrame<T, V extends TableView<unknown>>({
  view,
  onViewChange,
  rows,
  total,
  stale = false,
  loading,
  columns,
  lockedColumns = [],
  getRowId,
  filters,
  filtered,
  onResetFilters,
  selectedId,
  onSelect,
  onActivate,
  empty,
  problem,
  rowHeight,
  label,
  testId,
  bodyRef,
}: TableFrameProps<T, V>): React.JSX.Element {
  const searching = view.text.trim() !== '';
  const pages = total === null ? 1 : pageCount(total, view.pageSize);
  // A page past the end (rows synced away, or a narrower filter) falls back to the last page.
  useEffect(() => {
    if (!stale && total !== null && view.page > pages) onViewChange({ ...view, page: pages });
  });
  const scrollKey = JSON.stringify([view.text, view.facets, view.sort, view.page, view.pageSize]);
  return (
    <>
      <div
        className="@container flex h-12 items-center gap-2 px-6"
        data-testid={`${testId}.filters`}
      >
        {/* One row that scrolls sideways when a pane leaves it little room, never a second row.
            The right edge fades, so a filter running under it reads as more to scroll to. */}
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto pr-6 [mask-image:linear-gradient(to_right,black_calc(100%-32px),transparent)] [scrollbar-width:none]">
          {filters}
          {filtered ? (
            <Button
              variant="text"
              size="sm"
              label={t('core.table.filter.reset')}
              onClick={onResetFilters}
              data-testid={`${testId}.filters.reset`}
            />
          ) : null}
        </div>
        <div className="shrink-0">
          <ColumnsMenu
            label={t('core.table.columns')}
            columns={columns.map((column) => ({
              id: column.id!,
              label: String(column.header),
              visible: !view.hiddenColumns.includes(column.id!),
              locked: lockedColumns.includes(column.id!),
            }))}
            onToggle={(id, visible) =>
              onViewChange({
                ...view,
                hiddenColumns: visible
                  ? view.hiddenColumns.filter((other) => other !== id)
                  : [...view.hiddenColumns, id],
              })
            }
            testId={`${testId}.columns`}
          />
        </div>
      </div>
      <DataTable
        rows={rows}
        columns={columns}
        getRowId={getRowId}
        hiddenColumns={view.hiddenColumns}
        selectedId={selectedId}
        onSelect={(row) => {
          if (!stale) onSelect(row);
        }}
        onActivate={(row) => {
          if (!stale) onActivate?.(row);
        }}
        bodyRef={bodyRef}
        // The read sorts, across every page; the headers only choose the order.
        manualSorting
        sorting={view.sort === null ? [] : [{ id: view.sort.column, desc: view.sort.descending }]}
        onSortingChange={(next) => {
          const first = next[0];
          onViewChange(
            changeView(view, {
              sort: first === undefined ? null : { column: first.id, descending: first.desc },
            } as Partial<V>),
          );
        }}
        scrollKey={scrollKey}
        loading={loading}
        empty={
          problem ??
          (filtered || searching ? (
            <NarrowedEmpty filtered={filtered} onReset={onResetFilters} />
          ) : (
            empty
          ))
        }
        {...(rowHeight === undefined ? {} : { rowHeight })}
        label={label}
        testId={testId}
      />
      {total === null || total === 0 ? null : (
        <Pagination
          page={Math.min(view.page, pages)}
          pageSize={view.pageSize}
          total={total}
          pageSizes={PAGE_SIZES}
          onPageChange={(page) => onViewChange({ ...view, page })}
          onPageSizeChange={(pageSize) =>
            onViewChange(changeView(view, { pageSize } as Partial<V>))
          }
          labels={{
            range: (from, to, all) =>
              t('core.table.range', {
                from: formatNumber(from),
                to: formatNumber(to),
                total: formatNumber(all),
              }),
            perPage: (size) => t('core.table.perPage', { size }),
            previous: t('core.table.previous'),
            next: t('core.table.next'),
            page: (n) => t('core.table.page', { page: n }),
            label: t('core.table.pages'),
          }}
          testId={`${testId}.pagination`}
        />
      )}
    </>
  );
}
