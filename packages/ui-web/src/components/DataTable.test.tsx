import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DataTable, foldColumns, type ColumnDef } from './DataTable.js';

describe('foldColumns', () => {
  const columns = [
    { id: 'number', track: '96px' },
    { id: 'customer', track: 'minmax(140px, 1fr)' },
    { id: 'device', track: 'minmax(160px, 2fr)', fold: 3 },
    { id: 'technician', track: 'minmax(140px, 1fr)', fold: 2 },
    { id: 'received', track: '104px', fold: 1 },
    { id: 'total', track: '116px' },
  ];
  // Minimums 756 + 5 gaps of 12 + 48 padding + 16 scrollbar = 880.

  it('keeps every column when they fit', () => {
    expect(foldColumns(columns, 880)).toEqual([]);
  });

  it('folds the lowest-ranked columns first, only as many as needed', () => {
    expect(foldColumns(columns, 879)).toEqual(['received']);
    expect(foldColumns(columns, 760)).toEqual(['received', 'technician']);
    expect(foldColumns(columns, 500)).toEqual(['received', 'technician', 'device']);
  });

  it('never folds a column without a rank, however narrow', () => {
    expect(foldColumns(columns, 100)).toEqual(['received', 'technician', 'device']);
  });

  it('folds nothing before the width is known', () => {
    expect(foldColumns(columns, 0)).toEqual([]);
  });
});

interface Row {
  readonly id: string;
  readonly name: string;
}

const ROWS: Row[] = [
  { id: 'a', name: 'Alpha' },
  { id: 'b', name: 'Bravo' },
  { id: 'c', name: 'Charlie' },
];
const COLUMNS: ColumnDef<Row, unknown>[] = [
  { id: 'name', accessorFn: (row) => row.name, header: 'Name', meta: { track: '1fr' } },
];

describe('DataTable keyboard', () => {
  beforeAll(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    // jsdom has no layout: give the scroll area a height so the virtual rows render.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
  });
  afterEach(cleanup);

  it('moves the selection with the arrows and opens the row with Enter', () => {
    const onSelect = vi.fn();
    const onActivate = vi.fn();
    const { rerender } = render(
      <DataTable
        rows={ROWS}
        columns={COLUMNS}
        getRowId={(row) => row.id}
        selectedId="a"
        onSelect={onSelect}
        onActivate={onActivate}
        label="Rows"
        testId="t"
      />,
    );
    const body = screen.getAllByRole('rowgroup')[1]!;
    fireEvent.keyDown(body, { key: 'ArrowDown' });
    expect(onSelect).toHaveBeenLastCalledWith(ROWS[1]);
    fireEvent.keyDown(body, { key: 'End' });
    expect(onSelect).toHaveBeenLastCalledWith(ROWS[2]);

    rerender(
      <DataTable
        rows={ROWS}
        columns={COLUMNS}
        getRowId={(row) => row.id}
        selectedId="c"
        onSelect={onSelect}
        onActivate={onActivate}
        label="Rows"
        testId="t"
      />,
    );
    fireEvent.keyDown(body, { key: 'ArrowDown' });
    expect(onSelect).toHaveBeenLastCalledWith(ROWS[2]);
    fireEvent.keyDown(body, { key: 'Enter' });
    expect(onActivate).toHaveBeenCalledWith(ROWS[2]);
  });

  it('selects a row on click', () => {
    const onSelect = vi.fn();
    render(
      <DataTable
        rows={ROWS}
        columns={COLUMNS}
        getRowId={(row) => row.id}
        selectedId={null}
        onSelect={onSelect}
        label="Rows"
        testId="t"
      />,
    );
    fireEvent.click(screen.getByTestId('t.row.b'));
    expect(onSelect).toHaveBeenCalledWith(ROWS[1]);
  });
});
