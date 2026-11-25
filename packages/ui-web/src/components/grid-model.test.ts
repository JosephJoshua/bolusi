import { describe, expect, it } from 'vitest';

import {
  clearBlock,
  copyBlock,
  headingMap,
  parseClipboardTable,
  pasteBlock,
  toClipboardTable,
  withTrailingRow,
  type GridRow,
} from './grid-model.js';

const COLUMNS = [
  { id: 'q', label: 'Kualitas' },
  { id: 'hp', label: 'HP', aliases: ['Tipe HP'] },
  { id: 'name', label: 'Nama', readOnly: false },
  { id: 'stock', label: 'Stok' },
];
let next = 0;
const newRow = (): GridRow => ({ id: `n${String((next += 1))}`, cells: {} });
const row = (cells: Record<string, string>): GridRow => ({ id: `r${String((next += 1))}`, cells });
const at = (r: number, c: number) => ({ anchor: { row: r, col: c }, focus: { row: r, col: c } });

describe('parseClipboardTable', () => {
  it('reads tabs and lines as Excel writes them, without an extra row for the last line break', () => {
    expect(parseClipboardTable('a\tb\r\nc\td\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(parseClipboardTable('one')).toEqual([['one']]);
  });

  it('keeps quoted cells whole: tabs, line breaks and doubled quotes inside', () => {
    expect(parseClipboardTable('"LCD\t""A14"""\tx\n"two\nlines"\ty')).toEqual([
      ['LCD\t"A14"', 'x'],
      ['two\nlines', 'y'],
    ]);
  });

  it('keeps empty cells and a quote in the middle of a cell as typed', () => {
    expect(parseClipboardTable('a\t\tc\n5" kabel\t')).toEqual([
      ['a', '', 'c'],
      ['5" kabel', ''],
    ]);
  });

  it('round-trips what it copies', () => {
    const block = [
      ['LCD "A14"', 'a\tb'],
      ['x\ny', ''],
    ];
    expect(parseClipboardTable(toClipboardTable(block))).toEqual(block);
  });
});

describe('headingMap', () => {
  it('maps a heading row by column name or alias, whatever its case or order', () => {
    expect(
      headingMap(
        [
          ['stok', 'Tipe HP (opsional)', 'Catatan'],
          ['1', 'A14', 'x'],
        ],
        COLUMNS,
      ),
    ).toBeNull();
    expect(
      headingMap(
        [
          ['stok', 'Tipe HP (opsional)', ''],
          ['1', 'A14', ''],
        ],
        COLUMNS,
      ),
    ).toEqual(['stock', 'hp', null]);
  });

  it('is not a heading row when fewer than two cells name columns, or with nothing under it', () => {
    expect(
      headingMap(
        [
          ['Stok', 'A14'],
          ['1', 'x'],
        ],
        COLUMNS,
      ),
    ).toBeNull();
    expect(headingMap([['Stok', 'HP']], COLUMNS)).toBeNull();
  });
});

describe('pasteBlock', () => {
  it('lands a block at the selected cell, adding rows and dropping columns past the last', () => {
    const rows = [row({}), row({})];
    const result = pasteBlock({
      rows,
      columns: COLUMNS,
      selection: at(1, 2),
      block: [
        ['n1', '3', 'extra'],
        ['n2', '4', 'extra'],
      ],
      newRow,
    })!;
    expect(result.rows.map((r) => r.cells)).toEqual([
      {},
      { name: 'n1', stock: '3' },
      { name: 'n2', stock: '4' },
    ]);
    expect(result.range).toEqual({ anchor: { row: 1, col: 2 }, focus: { row: 2, col: 3 } });
  });

  it('maps a pasted heading row by name, from the selected row', () => {
    const result = pasteBlock({
      rows: [row({})],
      columns: COLUMNS,
      selection: at(0, 3),
      block: [
        ['HP', 'Kualitas'],
        ['A14', 'Original'],
      ],
      newRow,
    })!;
    expect(result.rows.map((r) => r.cells)).toEqual([{ hp: 'A14', q: 'Original' }]);
  });

  it('fills a selected block with one pasted value, skipping read-only columns', () => {
    const columns = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B', readOnly: true },
    ];
    const result = pasteBlock({
      rows: [row({}), row({})],
      columns,
      selection: { anchor: { row: 0, col: 0 }, focus: { row: 1, col: 1 } },
      block: [['x']],
      newRow,
    })!;
    expect(result.rows.map((r) => r.cells)).toEqual([{ a: 'x' }, { a: 'x' }]);
  });
});

describe('copy and clear', () => {
  const rows = [row({ q: 'OEM', hp: 'A14' }), row({ q: 'KW', stock: '2' })];
  const all = { top: 0, left: 0, bottom: 1, right: 1 };

  it('copies the selected block row by row', () => {
    expect(copyBlock(rows, COLUMNS, all)).toEqual([
      ['OEM', 'A14'],
      ['KW', ''],
    ]);
  });

  it('clears only the selected block', () => {
    expect(clearBlock(rows, COLUMNS, all).map((r) => r.cells)).toEqual([
      { q: '', hp: '' },
      { q: '', hp: '', stock: '2' },
    ]);
  });
});

describe('withTrailingRow', () => {
  it('keeps exactly one empty row at the end', () => {
    const filled = row({ q: 'OEM' });
    const spare = row({ q: ' ' });
    expect(withTrailingRow([filled, spare, row({})], newRow)).toEqual([filled, spare]);
    const result = withTrailingRow([filled], newRow);
    expect(result).toHaveLength(2);
    expect(result[1]!.cells).toEqual({});
  });
});
