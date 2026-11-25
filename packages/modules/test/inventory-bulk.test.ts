// Entering many items at once from the PC's sheet (owner decision, 2026-10-28): `addItems` saves a
// run of rows with their stock, all or none, and each row of the sheet reads into one item with
// the name its category's format builds, values spelled as the category spells them and phones
// matched to the catalog.
import { initI18n } from '@bolusi/i18n';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';

import { DomainError } from '@bolusi/core';

import enCatalog from '../inventory/i18n/en.json' with { type: 'json' };
import idCatalog from '../inventory/i18n/id.json' with { type: 'json' };
import { registerInventoryCatalog } from '../src/inventory/i18n.js';

import { bulkColumns, readRow, splitList, type RowContext } from '../src/inventory/bulk-entry.js';
import type { CategoryField } from '../src/inventory/categories.js';
import type { CategoryRow } from '../src/inventory/queries.js';
import { openRepairHarness, type RepairHarness } from './support/repair-harness.js';

beforeAll(() => {
  initI18n({ locale: 'id' });
  registerInventoryCatalog({ id: idCatalog, en: enCatalog });
});

const open: RepairHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function harness(seed: number): Promise<RepairHarness> {
  const h = await openRepairHarness(seed);
  open.push(h);
  return h;
}

const FIELDS: CategoryField[] = [
  { id: 'hp', label: 'HP', kind: 'phones', options: [] },
  { id: 'q', label: 'Kualitas', kind: 'one', options: ['Original', 'OEM'] },
  { id: 'x', label: 'Tambahan', kind: 'many', options: ['+ frame'] },
];
const LCD = {
  name: 'LCD',
  isPart: true,
  fields: FIELDS,
  nameFormat: 'LCD {HP} {Kualitas} {Tambahan}',
};

async function lcdCategory(h: RepairHarness): Promise<string> {
  return ((await h.runInventory('addCategory', LCD, h.ownerId)) as { categoryId: string })
    .categoryId;
}

describe('addItems', () => {
  test('adds every item with its count in one save', async () => {
    const h = await harness(7601);
    const categoryId = await lcdCategory(h);
    const { itemIds } = (await h.runInventory(
      'addItems',
      {
        items: [
          {
            nameAuto: true,
            categoryId,
            values: { q: ['OEM'] },
            fits: [{ brand: 'Samsung', model: 'Galaxy A14' }],
            counted: 4,
          },
          { name: 'Lem B7000', code: 'LEM-15', tags: ['bahan'] },
        ],
      },
      h.storeOwnerId,
    )) as { itemIds: string[] };
    expect(itemIds).toHaveLength(2);
    const rows = (await h.queryInventory('listItems', {}, h.ownerId)).rows;
    expect(rows.map((row) => [row['name'], row['onHand']])).toEqual(
      expect.arrayContaining([
        ['LCD Samsung Galaxy A14 OEM', 4],
        ['Lem B7000', 0],
      ]),
    );
  });

  test('is all or none: one bad item leaves nothing behind', async () => {
    const h = await harness(7602);
    const err = await h
      .runInventory(
        'addItems',
        {
          items: [
            { name: 'Baterai BN54', counted: 2 },
            { nameAuto: true, categoryId: '01960000-0000-7000-8000-000000000000' },
          ],
        },
        h.storeOwnerId,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((await h.queryInventory('listItems', {}, h.ownerId)).rows).toEqual([]);
  });

  test('needs the right to keep the list, like adding one item', async () => {
    const h = await harness(7603);
    const err = await h
      .runInventory('addItems', { items: [{ name: 'Lem B7000' }] }, h.technicianId)
      .catch((e: unknown) => e);
    expect((err as DomainError).code).toBe('PERMISSION_DENIED');
  });
});

const CATEGORY: CategoryRow = {
  id: 'cat-lcd',
  ...LCD,
  archived: false,
} as unknown as CategoryRow;

function ctx(overrides: Partial<RowContext> = {}): RowContext {
  const known = new Map([
    ['q\u0000oem', 'OEM'],
    ['x\u0000+ frame', '+ frame'],
    ['tag\u0000laris', 'Laris'],
  ]);
  return {
    category: CATEGORY,
    columns: bulkColumns(CATEGORY, true),
    spelling: (facet, value) => known.get(`${facet}\u0000${value.toLowerCase()}`),
    fit: (typed) =>
      typed.toLowerCase() === 'galaxy a14'
        ? { exact: { brand: 'Samsung', model: 'Galaxy A14' }, near: null }
        : { exact: null, near: { brand: 'Samsung', model: 'Galaxy A15' } },
    strict: true,
    ...overrides,
  };
}

describe('reading a row of the sheet', () => {
  test('a column per field in the category order, then name, codes, labels and stock', () => {
    expect(bulkColumns(CATEGORY, true).map((c) => c.id)).toEqual([
      'fits',
      'field.q',
      'field.x',
      'name',
      'code',
      'barcode',
      'tags',
      'stock',
    ]);
    expect(bulkColumns(null, false).map((c) => c.id)).toEqual([
      'name',
      'fits',
      'code',
      'barcode',
      'tags',
    ]);
  });

  test('builds the name from the fields, spelling values as the category does', () => {
    const row = readRow(
      {
        fits: 'galaxy a14',
        'field.q': 'oem',
        'field.x': '+ Frame; + frame',
        tags: 'laris',
        stock: '1.200',
      },
      ctx(),
    );
    expect(row.ready).toBe(true);
    expect(row.builtName).toBe('LCD Samsung Galaxy A14 OEM + frame');
    expect(row.item).toMatchObject({
      nameAuto: true,
      name: '',
      values: { q: ['OEM'], x: ['+ frame'] },
      tags: ['Laris'],
      fits: [{ brand: 'Samsung', model: 'Galaxy A14' }],
      counted: 1200,
    });
  });

  test('a typed name wins over the format', () => {
    const row = readRow({ 'field.q': 'KW', name: 'LCD A14 copotan' }, ctx());
    expect(row.item).toMatchObject({ nameAuto: false, name: 'LCD A14 copotan' });
  });

  test('a phone the catalog lacks is kept as typed, with the closest one suggested', () => {
    const row = readRow({ fits: 'A15 baru', 'field.q': 'OEM' }, ctx());
    expect(row.ready).toBe(true);
    expect(row.item.fits).toEqual([{ brand: '', model: 'A15 baru' }]);
    expect(row.problems['fits']).toMatchObject({ tone: 'warning' });
    expect(row.problems['fits']!.message).toContain('Samsung Galaxy A15');
  });

  test('a stock that is not a whole number stops the row', () => {
    const row = readRow({ 'field.q': 'OEM', stock: '2,5' }, ctx());
    expect(row.ready).toBe(false);
    expect(row.problems['stock']).toMatchObject({ tone: 'danger' });
  });

  test('a missing name is said only once saving was tried', () => {
    const cells = { code: 'X1' };
    expect(
      readRow(cells, ctx({ category: null, columns: bulkColumns(null, true), strict: false })),
    ).toMatchObject({ ready: false, problems: {} });
    expect(
      readRow(cells, ctx({ category: null, columns: bulkColumns(null, true) })).problems['name'],
    ).toMatchObject({ tone: 'danger' });
  });

  test('an empty row is not filled, and lists split on commas and semicolons', () => {
    expect(readRow({ name: '  ' }, ctx()).filled).toBe(false);
    expect(splitList(' a , b;; c ')).toEqual(['a', 'b', 'c']);
  });
});
