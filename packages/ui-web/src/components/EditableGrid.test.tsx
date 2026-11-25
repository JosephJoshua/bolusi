import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { EditableGrid, matchSuggestions, type GridColumn, type GridRow } from './EditableGrid.js';
import { TooltipProvider } from './Tooltip.js';

const COLUMNS: GridColumn[] = [
  { id: 'q', label: 'Kualitas', width: 120, suggestions: ['Original', 'OEM', 'KW'] },
  {
    id: 'x',
    label: 'Tambahan',
    width: 160,
    multiple: true,
    suggestions: ['+ frame', '+ backdoor'],
  },
  { id: 'stock', label: 'Stok', width: 80, align: 'end', numeric: true },
];

let n = 0;
const newRow = (): GridRow => ({ id: `row${String((n += 1))}`, cells: {} });

function Harness({ onRows }: { readonly onRows?: (rows: readonly GridRow[]) => void }) {
  const [rows, setRows] = useState<readonly GridRow[]>(() => [newRow()]);
  return (
    <TooltipProvider>
      <EditableGrid
        columns={COLUMNS}
        rows={rows}
        onChange={(next) => {
          setRows(next);
          onRows?.(next);
        }}
        newRow={newRow}
        labels={{
          row: (r) => `Baris ${String(r)}`,
          deleteRow: 'Hapus baris',
          where: (r, c) => `Baris ${String(r)}, ${c}`,
        }}
        label="Barang"
        testId="g"
      />
    </TooltipProvider>
  );
}

const body = (): HTMLElement => screen.getByTestId('g.body');
const cell = (r: number, id: string): HTMLElement =>
  screen.getByTestId(`g.cell.${String(r)}.${id}`);
const key = (k: string, init: Record<string, unknown> = {}): void => {
  fireEvent.keyDown(document.activeElement ?? body(), { key: k, ...init });
};

describe('EditableGrid', () => {
  beforeAll(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(900);
  });
  afterEach(cleanup);

  it('types over a cell, commits with Enter and keeps a spare row at the end', () => {
    let latest: readonly GridRow[] = [];
    render(<Harness onRows={(rows) => (latest = rows)} />);
    body().focus();
    key('K');
    const input = screen.getByTestId('g.input') as HTMLInputElement;
    expect(input.value).toBe('K');
    fireEvent.change(input, { target: { value: 'KW' } });
    key('Enter');
    expect(latest.map((r) => r.cells)).toEqual([{ q: 'KW' }, {}]);
    expect(cell(0, 'q').textContent).toBe('KW');
    // Enter moved down to the new spare row.
    expect(cell(1, 'q').getAttribute('aria-selected')).toBe('true');
  });

  it('takes a suggestion with Enter, and completes a list item by item', () => {
    let latest: readonly GridRow[] = [];
    render(<Harness onRows={(rows) => (latest = rows)} />);
    body().focus();
    key('o');
    expect(screen.getByTestId('g.suggestions').textContent).toContain('Original');
    key('Enter');
    expect(latest[0]!.cells['q']).toBe('Original');

    fireEvent.mouseDown(cell(0, 'x'), { button: 0 });
    key('+');
    key('Enter');
    const input = screen.getByTestId('g.input') as HTMLInputElement;
    expect(input.value).toBe('+ frame, ');
    fireEvent.change(input, { target: { value: '+ frame, +' } });
    expect(screen.getByTestId('g.suggestions').textContent).toBe('+ backdoor');
    key('Enter');
    key('Tab');
    expect(latest[0]!.cells['x']).toBe('+ frame, + backdoor, ');
  });

  it('pastes a block from Excel across cells and undoes it with Ctrl+Z', () => {
    let latest: readonly GridRow[] = [];
    render(<Harness onRows={(rows) => (latest = rows)} />);
    body().focus();
    fireEvent.paste(body(), {
      clipboardData: { getData: () => 'OEM\t+ frame\t2\r\nKW\t\t5\r\n' },
    });
    expect(latest.map((r) => r.cells)).toEqual([
      { q: 'OEM', x: '+ frame', stock: '2' },
      { q: 'KW', x: '', stock: '5' },
      {},
    ]);
    key('z', { ctrlKey: true });
    expect(latest.map((r) => r.cells)).toEqual([{}]);
    key('y', { ctrlKey: true });
    expect(latest).toHaveLength(3);
  });

  it('copies the selected block as Excel reads it, and Delete clears it', () => {
    let latest: readonly GridRow[] = [];
    render(<Harness onRows={(rows) => (latest = rows)} />);
    body().focus();
    fireEvent.paste(body(), { clipboardData: { getData: () => 'OEM\ta\nKW\tb' } });
    fireEvent.mouseDown(cell(0, 'q'), { button: 0 });
    fireEvent.mouseDown(cell(1, 'x'), { button: 0, shiftKey: true });
    let copied = '';
    fireEvent.copy(body(), {
      clipboardData: { setData: (_type: string, text: string) => (copied = text) },
    });
    expect(copied).toBe('OEM\ta\nKW\tb');
    key('Delete');
    // Emptied rows at the end fold into the one spare row.
    expect(latest.map((r) => r.cells)).toEqual([{ q: '', x: '' }]);
  });

  it('deletes the selected row with Ctrl+−', () => {
    let latest: readonly GridRow[] = [];
    render(<Harness onRows={(rows) => (latest = rows)} />);
    body().focus();
    fireEvent.paste(body(), { clipboardData: { getData: () => 'OEM\nKW' } });
    fireEvent.mouseDown(cell(0, 'q'), { button: 0 });
    key('-', { ctrlKey: true });
    expect(latest.map((r) => r.cells['q'])).toEqual(['KW', undefined]);
  });
});

describe('matchSuggestions', () => {
  it('puts values that start with the text first, then those containing it', () => {
    expect(matchSuggestions(['KW Super', 'Original', 'OEM', 'Copy KW'], 'kw', false)).toEqual([
      'KW Super',
      'Copy KW',
    ]);
  });

  it('completes the last list item and leaves out the ones already there', () => {
    expect(matchSuggestions(['+ frame', '+ backdoor'], '+ frame, +', true)).toEqual(['+ backdoor']);
    expect(matchSuggestions(['+ frame'], '+ frame, ', true)).toEqual([]);
  });
});
