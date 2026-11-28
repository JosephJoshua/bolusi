// What a list is showing, on any client: the typed search, the facets someone picked, the column it
// is sorted by, the page and how many rows a page holds, and the columns hidden. Every list on the
// phone and the PC keeps one of these, so search, filters, sorting and paging behave the same way
// everywhere and no screen builds its own.
//
// The app holds the views (`TableViewProvider`), so a list comes back as it was left after a trip
// into a record or another place. How a person likes a table (its sort, page size and columns)
// is remembered per person on this device through the provider's store; what they typed or
// picked lasts for the session only.
import { tablePage, type ColumnSort, type SearchDocument, type TablePage } from '@bolusi/core';
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export type { ColumnSort };

export interface TableView<F, C extends string = string> {
  readonly text: string;
  readonly facets: F;
  /** Null keeps the list's own order (or search ranking). */
  readonly sort: ColumnSort<C> | null;
  /** From 1. */
  readonly page: number;
  readonly pageSize: number;
  readonly hiddenColumns: readonly string[];
}

export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 50;

export function tableView<F, C extends string = string>(
  facets: F,
  patch: Partial<TableView<F, C>> = {},
): TableView<F, C> {
  return {
    text: '',
    facets,
    sort: null,
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    hiddenColumns: [],
    ...patch,
  };
}

/** A change to the view: anything but a page turn starts again from the first page. */
export function changeView<V extends TableView<unknown>>(view: V, patch: Partial<V>): V {
  return { ...view, page: 1, ...patch };
}

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** The `offset`/`limit` a query reads for the view's page. */
export function pageWindow(view: { readonly page: number; readonly pageSize: number }): {
  readonly offset: number;
  readonly limit: number;
} {
  return { offset: (view.page - 1) * view.pageSize, limit: view.pageSize };
}

/**
 * A whole list, already in memory, through a view: fuzzy search (with the shop's synonyms) ranks
 * it, the facets narrow it, a column sorts it and the page cuts it, as `tablePage` does in a query.
 */
export function viewRows<T, F, C extends string>(
  rows: readonly T[],
  view: TableView<F, C>,
  how: {
    /** What search matches a row on. */
    readonly document: (row: T) => Omit<SearchDocument, 'id' | 'rank'>;
    readonly id: (row: T) => string;
    readonly matches?: ((row: T, facets: F) => boolean) | undefined;
    readonly value: (row: T, column: C) => string | number | null;
  },
): TablePage<T> {
  const matches = how.matches;
  const kept = matches === undefined ? rows : rows.filter((row) => matches(row, view.facets));
  return tablePage(kept, { text: view.text, sort: view.sort, ...pageWindow(view) }, how);
}

/** Where the provider remembers a person's table setup on this device. Fails soft. */
export interface TableViewStore {
  read(key: string): string | null;
  write(key: string, value: string): void;
}

/** The part of a view that is remembered: how the person likes the table, not what they looked for. */
interface Remembered {
  readonly sort: ColumnSort | null;
  readonly pageSize: number;
  readonly hiddenColumns: readonly string[];
}

interface TableViews {
  get(key: string): TableView<unknown> | undefined;
  set(key: string, view: TableView<unknown>): void;
  remembered(key: string): Partial<Remembered>;
}

const TableViewContext = createContext<TableViews | null>(null);

/**
 * Holds every list's view for the signed-in person. Keyed by `personId`, so a shared counter PC
 * gives each cashier their own columns, sort and page size.
 */
export function TableViewProvider({
  personId,
  store,
  children,
}: {
  readonly personId: string | null;
  readonly store?: TableViewStore | undefined;
  readonly children: ReactNode;
}): React.JSX.Element {
  const views = useRef(new Map<string, TableView<unknown>>());
  const value = useMemo<TableViews>(() => {
    const storeKey = (key: string): string => `table:${personId ?? '-'}:${key}`;
    return {
      get: (key) => views.current.get(`${personId ?? '-'}:${key}`),
      set: (key, view) => {
        views.current.set(`${personId ?? '-'}:${key}`, view);
        if (store === undefined) return;
        const remembered: Remembered = {
          sort: view.sort,
          pageSize: view.pageSize,
          hiddenColumns: view.hiddenColumns,
        };
        try {
          store.write(storeKey(key), JSON.stringify(remembered));
        } catch {
          // Not remembered; the table still works.
        }
      },
      remembered: (key) => {
        if (store === undefined) return {};
        try {
          const raw = store.read(storeKey(key));
          return raw === null ? {} : parseRemembered(raw);
        } catch {
          return {};
        }
      },
    };
  }, [personId, store]);
  return <TableViewContext.Provider value={value}>{children}</TableViewContext.Provider>;
}

function parseRemembered(raw: string): Partial<Remembered> {
  const value = JSON.parse(raw) as Record<string, unknown>;
  const out: { -readonly [K in keyof Remembered]?: Remembered[K] } = {};
  if (
    typeof value.pageSize === 'number' &&
    (PAGE_SIZES as readonly number[]).includes(value.pageSize)
  )
    out.pageSize = value.pageSize;
  if (
    Array.isArray(value.hiddenColumns) &&
    value.hiddenColumns.every((id) => typeof id === 'string')
  )
    out.hiddenColumns = value.hiddenColumns as string[];
  const sort = value.sort as Record<string, unknown> | null | undefined;
  if (sort === null) out.sort = null;
  else if (typeof sort?.column === 'string' && typeof sort.descending === 'boolean')
    out.sort = { column: sort.column, descending: sort.descending };
  return out;
}

/**
 * One list's view, kept by the app for as long as it runs. `initial` is the list's first view;
 * `sortable` lists the columns this list can sort by now, so a remembered sort on a column the list
 * no longer offers is dropped instead of silently ordering by nothing.
 */
export function useTableView<V extends TableView<unknown>>(
  key: string,
  initial: () => V,
  options: { readonly sortable?: readonly string[] } = {},
): readonly [V, (next: V) => void] {
  const views = useContext(TableViewContext);
  const [own, setOwn] = useState<V | null>(null);
  const sortable = options.sortable;
  const view = useMemo<V>(() => {
    // With a provider the app's copy is the truth (`own` only re-renders); without one, `own` is.
    const kept = views === null ? own : (views.get(key) as V | undefined);
    if (kept !== undefined && kept !== null) return kept;
    const first = initial();
    const remembered = views?.remembered(key) ?? {};
    const sort =
      remembered.sort === undefined ||
      (remembered.sort !== null &&
        sortable !== undefined &&
        !sortable.includes(remembered.sort.column))
        ? first.sort
        : remembered.sort;
    return { ...first, ...remembered, sort };
    // `initial` and `sortable` are read once per list, as `useState`'s initializer would.
  }, [views, key, own]);
  const setView = useCallback(
    (next: V) => {
      views?.set(key, next as TableView<unknown>);
      setOwn(next);
    },
    [views, key],
  );
  return [view, setView];
}
