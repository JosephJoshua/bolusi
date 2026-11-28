// One page of a table, the same way for every list: typed text ranks the rows with the shared fuzzy
// search (synonyms included), a column sorts them with empty values last, and the page cuts them,
// with the total across every page for the footer. A list query builds the rows its facets let
// through and hands them here; the screens' `TableView` asks for exactly these inputs, so search,
// sorting and paging behave the same way on every table, phone or PC.
//
// For a list the device can read whole (orders, transfers, suppliers, staff). A long history that
// must page in SQL (the servisan board, Kas, items) sorts and counts in its own query.
import { z } from 'zod';

import type { SearchDocument } from '../search/fuzzy.js';
import { FuzzyIndex } from '../search/fuzzy-index.js';
import type { QueryPage } from './qctx.js';

export interface ColumnSort<C extends string = string> {
  readonly column: C;
  readonly descending: boolean;
}

/** The input every table query takes besides its facets: search, sort and page. */
export function tableInputShape<C extends readonly [string, ...string[]]>(columns: C) {
  return {
    text: z.string().trim().max(200).default(''),
    sort: z
      .object({ column: z.enum(columns), descending: z.boolean() })
      .strict()
      .nullable()
      .default(null),
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).default(0),
  };
}

export interface TablePageInput<C extends string> {
  readonly text: string;
  readonly sort: ColumnSort<C> | null;
  readonly offset: number;
  readonly limit: number;
}

/** A page of rows with the count across every page. */
export interface TablePage<T> extends QueryPage<T> {
  readonly total: number;
}

type SortValue = string | number | null;

const isEmpty = (value: SortValue): boolean => value === null || value === '';

/** Compares two values the way a column sorts: text by Indonesian collation, the rest by number. */
export function compareValues(a: SortValue, b: SortValue): number {
  if (isEmpty(a)) return isEmpty(b) ? 0 : 1;
  if (isEmpty(b)) return -1;
  return typeof a === 'string' && typeof b === 'string'
    ? a.localeCompare(b, 'id', { sensitivity: 'base', numeric: true })
    : Number(a) - Number(b);
}

/** Rows by a column's value, empty values last either way; without a sort the order is kept. */
export function sortBy<T, C extends string>(
  rows: readonly T[],
  sort: ColumnSort<C> | null,
  value: (row: T, column: C) => SortValue,
): readonly T[] {
  if (sort === null) return rows;
  const sign = sort.descending ? -1 : 1;
  return rows
    .map((row, index) => ({ row, index, key: value(row, sort.column) }))
    .sort((a, b) => {
      if (isEmpty(a.key) !== isEmpty(b.key)) return isEmpty(a.key) ? 1 : -1;
      return sign * compareValues(a.key, b.key) || a.index - b.index;
    })
    .map(({ row }) => row);
}

/** The rows matching `text`, best first, earlier rows first among equals; all of them for no text. */
export function searchRows<T>(
  rows: readonly T[],
  text: string,
  how: {
    readonly id: (row: T) => string;
    readonly document: (row: T) => Omit<SearchDocument, 'id' | 'rank'>;
  },
): readonly T[] {
  if (text.trim() === '') return rows;
  const byId = new Map(rows.map((row) => [how.id(row), row]));
  const index = new FuzzyIndex(
    rows.map((row, at) => ({ ...how.document(row), id: how.id(row), rank: -at })),
  );
  return index.search(text, rows.length).map((hit) => byId.get(hit.id)!);
}

/** Search, sort and page rows the query has already narrowed by its facets. */
export function tablePage<T, C extends string>(
  rows: readonly T[],
  input: TablePageInput<C>,
  how: {
    readonly id: (row: T) => string;
    readonly document: (row: T) => Omit<SearchDocument, 'id' | 'rank'>;
    readonly value: (row: T, column: C) => SortValue;
  },
): TablePage<T> {
  const sorted = sortBy(searchRows(rows, input.text, how), input.sort, how.value);
  const end = input.offset + input.limit;
  return {
    rows: sorted.slice(input.offset, end),
    nextCursor: end < sorted.length ? String(end) : null,
    total: sorted.length,
  };
}
