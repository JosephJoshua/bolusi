// A list's view on any client: search ranks with the shop's synonyms, facets narrow, a column
// sorts with empty values last, the page cuts, and any change but a page turn starts on page 1.
import { describe, expect, test } from 'vitest';

import {
  changeView,
  pageWindow,
  sortBy,
  tableView,
  viewRows,
} from '../src/screen-kit/table-view.js';

interface Part {
  readonly id: string;
  readonly name: string;
  readonly stock: number | null;
  readonly category: string;
}

const parts: Part[] = [
  { id: 'a', name: 'Baterai Oppo A5s', stock: 4, category: 'battery' },
  { id: 'b', name: 'LCD Samsung A12', stock: 0, category: 'screen' },
  { id: 'c', name: 'Battery iPhone 11', stock: null, category: 'battery' },
  { id: 'd', name: 'Konektor cas type C', stock: 12, category: 'port' },
];

const how = {
  document: (part: Part) => ({ text: [part.name] }),
  id: (part: Part) => part.id,
  matches: (part: Part, facets: { readonly categories: readonly string[] }) =>
    facets.categories.length === 0 || facets.categories.includes(part.category),
  value: (part: Part, column: 'name' | 'stock') => (column === 'name' ? part.name : part.stock),
};

const ids = (rows: readonly Part[]) => rows.map((part) => part.id);

describe('table view', () => {
  const view = tableView<{ readonly categories: readonly string[] }, 'name' | 'stock'>({
    categories: [],
  });

  test('search ranks every row, synonyms included', () => {
    const found = viewRows(parts, { ...view, text: 'batre' }, how);
    expect(found.total).toBe(2);
    expect(ids(found.rows)).toEqual(expect.arrayContaining(['a', 'c']));
  });

  test('facets narrow search results and the whole list alike', () => {
    expect(ids(viewRows(parts, { ...view, facets: { categories: ['port'] } }, how).rows)).toEqual([
      'd',
    ]);
    const searched = viewRows(
      parts,
      { ...view, text: 'samsung', facets: { categories: ['battery'] } },
      how,
    );
    expect(searched.total).toBe(0);
  });

  test('a column sorts both ways, with empty values last either way', () => {
    const up = viewRows(parts, { ...view, sort: { column: 'stock', descending: false } }, how);
    expect(ids(up.rows)).toEqual(['b', 'a', 'd', 'c']);
    const down = viewRows(parts, { ...view, sort: { column: 'stock', descending: true } }, how);
    expect(ids(down.rows)).toEqual(['d', 'a', 'b', 'c']);
  });

  test('text sorts the Indonesian way, numbers inside names in order', () => {
    const rows = [{ n: 'Redmi 10' }, { n: 'redmi 9' }, { n: 'Oppo' }];
    expect(
      sortBy(rows, { column: 'n', descending: false }, (row) => row.n).map((row) => row.n),
    ).toEqual(['Oppo', 'redmi 9', 'Redmi 10']);
  });

  test('the page cuts the rows and the total counts them all', () => {
    const paged = viewRows(parts, { ...view, pageSize: 2, page: 2 }, how);
    expect(paged.total).toBe(4);
    expect(ids(paged.rows)).toEqual(['c', 'd']);
    expect(pageWindow({ page: 3, pageSize: 25 })).toEqual({ offset: 50, limit: 25 });
  });

  test('any change but a page turn starts again on page 1', () => {
    const onPage3 = { ...view, page: 3 };
    expect(changeView(onPage3, { text: 'lcd' }).page).toBe(1);
    expect(changeView(onPage3, { pageSize: 100 }).page).toBe(1);
  });
});
