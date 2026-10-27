// A data table for long working lists: sticky sortable headers, only the visible rows rendered,
// one selected row driven by mouse or arrow keys, Enter to act on it, and more rows loaded as the
// end scrolls into view. Columns size themselves with CSS grid tracks, so a column can give way
// when a detail pane opens beside the table.
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { clsx } from 'clsx';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import { Skeleton } from './States.js';

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData, TValue> {
    /** The CSS grid track, such as `minmax(160px, 2fr)` or `120px`. */
    readonly track: string;
    readonly align?: 'start' | 'end';
    /**
     * When the table is too narrow for every column's minimum width, columns with a `fold` give
     * way, lowest first; columns without one always stay.
     */
    readonly fold?: number;
  }
}

const ROW_PADDING = 48; // px-6 on both sides
const COLUMN_GAP = 12; // gap-x-3
const SCROLLBAR = 16; // the gutter both row groups reserve

/** The smallest width a grid track can take: its fixed size, or the minimum of its `minmax`. */
function trackMinimum(track: string): number {
  const match = /^(?:minmax\()?(\d+)px/.exec(track);
  return match === null ? 0 : Number(match[1]);
}

/** The foldable columns to hide so the rest fit in `width`, lowest `fold` first. */
export function foldColumns(
  columns: readonly {
    readonly id: string;
    readonly track: string;
    readonly fold?: number | undefined;
  }[],
  width: number,
): string[] {
  if (width <= 0) return [];
  const needed = (shown: readonly { readonly track: string }[]): number =>
    shown.reduce((sum, column) => sum + trackMinimum(column.track), 0) +
    COLUMN_GAP * Math.max(0, shown.length - 1) +
    ROW_PADDING +
    SCROLLBAR;
  let shown = [...columns];
  const folded: string[] = [];
  const order = columns
    .filter((column) => column.fold !== undefined)
    .sort((a, b) => (a.fold ?? 0) - (b.fold ?? 0));
  for (const column of order) {
    if (needed(shown) <= width) break;
    shown = shown.filter((candidate) => candidate.id !== column.id);
    folded.push(column.id);
  }
  return folded;
}

export type { ColumnDef, SortingState };

export interface DataTableProps<T> {
  readonly rows: readonly T[];
  readonly columns: readonly ColumnDef<T, unknown>[];
  readonly getRowId: (row: T) => string;
  /** Column ids to leave out, such as the ones a detail pane has no room for. */
  readonly hiddenColumns?: readonly string[];
  readonly selectedId: string | null;
  readonly onSelect: (row: T) => void;
  /** Enter or a double click on a row. */
  readonly onActivate?: ((row: T) => void) | undefined;
  /**
   * Whether headers sort the rows. Off for a list loaded page by page: sorting here would order
   * only the pages loaded so far.
   */
  readonly sortable?: boolean;
  readonly sorting?: SortingState;
  readonly onSortingChange?: (sorting: SortingState) => void;
  /**
   * The rows arrive already sorted (by the query, across every page); the headers only say which
   * order to ask for. Columns opt out with `enableSorting: false`.
   */
  readonly manualSorting?: boolean;
  /** Changing it scrolls back to the first row, such as on a new page of results. */
  readonly scrollKey?: string | undefined;
  readonly onEndReached?: (() => void) | undefined;
  readonly loading?: boolean;
  /** Shown in place of rows when there are none (and not loading). */
  readonly empty?: ReactNode;
  readonly rowHeight?: number;
  /** The table's accessible name. */
  readonly label: string;
  readonly testId?: string | undefined;
  /** The focusable body, so a page can hand focus back to the table (after closing a pane). */
  readonly bodyRef?: RefObject<HTMLDivElement | null> | undefined;
}

const SKELETON_ROWS = 8;
const NO_HIDDEN_COLUMNS: readonly string[] = [];

export function DataTable<T>({
  rows,
  columns,
  getRowId,
  hiddenColumns = NO_HIDDEN_COLUMNS,
  selectedId,
  onSelect,
  onActivate,
  sortable = true,
  sorting: sortingProp,
  onSortingChange,
  manualSorting = false,
  scrollKey,
  onEndReached,
  loading = false,
  empty,
  rowHeight = 60,
  label,
  testId,
  bodyRef,
}: DataTableProps<T>): React.JSX.Element {
  const [ownSorting, setOwnSorting] = useState<SortingState>([]);
  const frameRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);
  const folded = useMemo(
    () =>
      foldColumns(
        columns
          .filter((column) => column.id !== undefined && !hiddenColumns.includes(column.id))
          .map((column) => ({
            id: column.id!,
            track: column.meta?.track ?? '',
            fold: column.meta?.fold,
          })),
        width,
      ),
    [columns, hiddenColumns, width],
  );
  const sorting = sortingProp ?? ownSorting;
  const table = useReactTable<T>({
    data: rows as T[],
    columns: columns as ColumnDef<T, unknown>[],
    getRowId: (row) => getRowId(row),
    state: {
      sorting,
      columnVisibility: Object.fromEntries([...hiddenColumns, ...folded].map((id) => [id, false])),
    },
    onSortingChange: (updater) => {
      const next = typeof updater === 'function' ? updater(sorting) : updater;
      if (onSortingChange === undefined) setOwnSorting(next);
      else onSortingChange(next);
    },
    getCoreRowModel: getCoreRowModel(),
    ...(manualSorting ? { manualSorting: true } : { getSortedRowModel: getSortedRowModel() }),
    enableSorting: sortable,
    // A server-sorted column goes ascending, descending, then back to the list's own order.
    enableSortingRemoval: true,
  });

  const visibleColumns = table.getVisibleLeafColumns();
  const template = visibleColumns.map((column) => column.columnDef.meta?.track ?? '1fr').join(' ');
  const modelRows = table.getRowModel().rows;

  const ownScrollRef = useRef<HTMLDivElement>(null);
  const scrollRef = bodyRef ?? ownScrollRef;
  // The rows' ids, so the focused body can name the selected row to screen readers.
  const rowIdPrefix = useId();
  const virtualizer = useVirtualizer({
    count: modelRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 8,
  });
  const items = virtualizer.getVirtualItems();
  useEffect(() => {
    const body = scrollRef.current;
    if (scrollKey !== undefined && body !== null) body.scrollTop = 0;
  }, [scrollKey, scrollRef]);

  // Ask for more once the last rendered row is within a screen of the end.
  const lastIndex = items[items.length - 1]?.index ?? -1;
  const endReached = useRef(onEndReached);
  endReached.current = onEndReached;
  useEffect(() => {
    if (lastIndex >= 0 && lastIndex >= modelRows.length - 10) endReached.current?.();
  }, [lastIndex, modelRows.length]);

  const selectedIndex = modelRows.findIndex((row) => row.id === selectedId);
  const move = (index: number): void => {
    // The position on screen, which sorting makes different from the row's place in `rows`.
    const position = Math.max(0, Math.min(modelRows.length - 1, index));
    const row = modelRows[position];
    if (row === undefined) return;
    onSelect(row.original);
    virtualizer.scrollToIndex(position, { align: 'auto' });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 0) / rowHeight) - 1);
    const steps: Record<string, number> = {
      ArrowDown: 1,
      ArrowUp: -1,
      PageDown: page,
      PageUp: -page,
    };
    if (event.key in steps) {
      event.preventDefault();
      move(selectedIndex < 0 ? 0 : selectedIndex + steps[event.key]!);
    } else if (event.key === 'Home') {
      event.preventDefault();
      move(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      move(modelRows.length - 1);
    } else if (event.key === 'Enter' && selectedIndex >= 0) {
      event.preventDefault();
      onActivate?.(modelRows[selectedIndex]!.original);
    }
  };

  return (
    <div
      role="grid"
      aria-label={label}
      aria-rowcount={modelRows.length + 1}
      data-testid={testId}
      ref={frameRef}
      className="flex min-h-0 flex-1 flex-col"
    >
      {/* Both row groups reserve the scrollbar's width so the header lines up with the rows. */}
      <div
        role="rowgroup"
        className="overflow-hidden border-y border-border bg-surface-alt [scrollbar-gutter:stable]"
      >
        {table.getHeaderGroups().map((group) => (
          <div
            key={group.id}
            role="row"
            className="grid items-center gap-x-3 px-6"
            style={{ gridTemplateColumns: template }}
          >
            {group.headers.map((header) => {
              const sortable = header.column.getCanSort();
              const direction = header.column.getIsSorted();
              const end = header.column.columnDef.meta?.align === 'end';
              const title = flexRender(header.column.columnDef.header, header.getContext());
              return (
                <div
                  key={header.id}
                  role="columnheader"
                  aria-sort={
                    direction === 'asc'
                      ? 'ascending'
                      : direction === 'desc'
                        ? 'descending'
                        : undefined
                  }
                  className={clsx('flex h-10 min-w-0 items-center', end && 'justify-end')}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={header.column.getToggleSortingHandler()}
                      className={clsx(
                        'group -mx-1 inline-flex h-8 cursor-pointer items-center gap-1 rounded-xs px-1 text-small font-semibold hover:bg-black/5',
                        direction === false ? 'text-text-muted' : 'text-text',
                      )}
                    >
                      {title}
                      {direction === 'asc' ? (
                        <ArrowUp size={14} aria-hidden />
                      ) : direction === 'desc' ? (
                        <ArrowDown size={14} aria-hidden />
                      ) : (
                        <ChevronsUpDown
                          size={14}
                          aria-hidden
                          className="opacity-0 group-hover:opacity-60"
                        />
                      )}
                    </button>
                  ) : (
                    <span className="text-small font-semibold text-text-muted">{title}</span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div
        ref={scrollRef}
        role="rowgroup"
        tabIndex={0}
        // Only a row in the rendered window can be named; one scrolled away is not in the page.
        aria-activedescendant={
          items.some((item) => item.index === selectedIndex)
            ? `${rowIdPrefix}${String(selectedIndex)}`
            : undefined
        }
        onKeyDown={onKeyDown}
        className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
      >
        {loading && modelRows.length === 0 ? (
          Array.from({ length: SKELETON_ROWS }, (_, index) => (
            <div
              key={index}
              aria-hidden
              className="grid items-center gap-x-3 border-b border-border px-6"
              style={{ gridTemplateColumns: template, height: rowHeight }}
            >
              {visibleColumns.map((column) => (
                <Skeleton key={column.id} className="h-4 w-3/4" />
              ))}
            </div>
          ))
        ) : modelRows.length === 0 ? (
          empty
        ) : (
          <div style={{ height: virtualizer.getTotalSize() }} className="relative">
            {items.map((item) => {
              const row = modelRows[item.index]!;
              const selected = row.id === selectedId;
              return (
                <div
                  key={row.id}
                  role="row"
                  id={`${rowIdPrefix}${String(item.index)}`}
                  aria-rowindex={item.index + 2}
                  aria-selected={selected}
                  data-testid={testId === undefined ? undefined : `${testId}.row.${row.id}`}
                  onClick={() => onSelect(row.original)}
                  onDoubleClick={() => onActivate?.(row.original)}
                  className={clsx(
                    'absolute inset-x-0 grid cursor-pointer items-center gap-x-3 border-b border-border px-6 transition-colors',
                    selected ? 'bg-info-bg' : 'hover:bg-surface-alt',
                  )}
                  style={{
                    gridTemplateColumns: template,
                    height: rowHeight,
                    transform: `translateY(${String(item.start)}px)`,
                  }}
                >
                  {selected ? (
                    <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-primary" />
                  ) : null}
                  {row.getVisibleCells().map((cell) => (
                    <div
                      key={cell.id}
                      role="gridcell"
                      className={clsx(
                        'min-w-0',
                        cell.column.columnDef.meta?.align === 'end' &&
                          'justify-self-end text-right',
                      )}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
