// Categories, generated names, tags, filters and scanning (owner decision, 2026-10-28): each
// category lists the fields its items fill in and a name format built from them, so a long list
// entered by many people still reads one way; only the business owner sets categories up.
import { afterEach, describe, expect, test } from 'vitest';

import { DomainError, refusalKeyOf } from '@bolusi/core';

import { itemDetails, type ItemDetailRow } from '../src/inventory/queries.js';
import {
  categoryProblem,
  dropToken,
  formatItemName,
  phonesForName,
  renameToken,
  type CategoryField,
} from '../src/inventory/categories.js';
import { openRepairHarness, type RepairHarness } from './support/repair-harness.js';

const open: RepairHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function harness(seed: number): Promise<RepairHarness> {
  const h = await openRepairHarness(seed);
  open.push(h);
  return h;
}

async function expectRefused(p: Promise<unknown>, code: string, refusal?: string): Promise<void> {
  const err = await p.then(
    () => new Error(`expected ${code}, but the call resolved`),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
  if (refusal !== undefined) expect(refusalKeyOf(err)).toBe(refusal);
}

const LCD_FIELDS: CategoryField[] = [
  { id: 'hp', label: 'HP', kind: 'phones', options: [] },
  { id: 'q', label: 'Kualitas', kind: 'one', options: ['Original', 'OEM', 'KW'] },
  { id: 'x', label: 'Tambahan', kind: 'many', options: ['+ frame', '+ backdoor'] },
];

const LCD = {
  name: 'LCD',
  isPart: true,
  fields: LCD_FIELDS,
  nameFormat: 'LCD {HP} {Kualitas} {Tambahan}',
};

async function addCategory(h: RepairHarness, input: Record<string, unknown> = LCD) {
  return ((await h.runInventory('addCategory', input, h.ownerId)) as { categoryId: string })
    .categoryId;
}

async function addItem(h: RepairHarness, input: Record<string, unknown>) {
  return ((await h.runInventory('addItem', input, h.storeOwnerId)) as { itemId: string }).itemId;
}

async function item(h: RepairHarness, itemId: string) {
  return (await h.queryInventory('getItem', { itemId }, h.ownerId)).rows[0]!;
}

async function names(h: RepairHarness, input: Record<string, unknown>) {
  return (await h.queryInventory('listItems', input, h.ownerId)).rows.map((row) => row['name']);
}

const A14 = [
  { brand: 'Samsung', model: 'Galaxy A14' },
  { brand: 'Samsung', model: 'Galaxy A14 5G' },
];

describe('names from a format', () => {
  test('fills each field in, the phones said once per brand', () => {
    expect(formatItemName(LCD, { q: ['Original'], x: ['+ frame', '+ backdoor'] }, A14)).toBe(
      'LCD Samsung Galaxy A14/A14 5G Original + frame + backdoor',
    );
    expect(formatItemName(LCD, {}, [])).toBe('LCD');
    expect(
      phonesForName([
        { brand: 'Xiaomi', model: 'Redmi Note 10' },
        { brand: 'Xiaomi', model: 'Redmi Note 10S' },
        { brand: 'Xiaomi', model: 'Poco M5s' },
        { brand: 'Oppo', model: 'A57' },
      ]),
    ).toBe('Xiaomi Redmi Note 10/10S/Poco M5s/Oppo A57');
  });

  test('a format may only name the fields the category has', () => {
    expect(categoryProblem(LCD)).toBeNull();
    expect(categoryProblem({ ...LCD, nameFormat: 'LCD {Warna}' })).toBe('no field Warna');
    expect(
      categoryProblem({
        ...LCD,
        fields: [...LCD_FIELDS, { id: 'k2', label: 'kualitas', kind: 'text', options: [] }],
      }),
    ).toBe('field label kualitas twice');
    expect(renameToken('LCD {HP} {kualitas}', 'Kualitas', 'Grade')).toBe('LCD {HP} {Grade}');
    expect(dropToken('LCD {HP} {Kualitas} + {Tambahan}', 'kualitas')).toBe('LCD {HP} + {Tambahan}');
  });
});

describe('setting categories up', () => {
  test('only the business owner can, not a store owner or staff', async () => {
    const h = await harness(7101);
    await expectRefused(h.runInventory('addCategory', LCD, h.storeOwnerId), 'PERMISSION_DENIED');
    await expectRefused(h.runInventory('addCategory', LCD, h.technicianId), 'PERMISSION_DENIED');
    const categoryId = await addCategory(h);
    const rows = (await h.queryInventory('listCategories', {}, h.technicianId)).rows;
    expect(rows).toMatchObject([{ id: categoryId, name: 'LCD', isPart: true }]);
  });

  test('a format naming a field the category lacks is refused, by the rule too', async () => {
    const h = await harness(7102);
    await expectRefused(
      h.runInventory('addCategory', { ...LCD, nameFormat: 'LCD {Warna}' }, h.ownerId),
      'VALIDATION_FAILED',
      'inventory.refusal.categoryInvalid',
    );
  });
});

describe('items in a category', () => {
  test('are named by the format, values kept to the fields, tags once each', async () => {
    const h = await harness(7201);
    const categoryId = await addCategory(h);
    const itemId = await addItem(h, {
      nameAuto: true,
      categoryId,
      values: { q: ['Original', 'OEM'], x: ['+ frame', '+ Frame'], gone: ['x'] },
      tags: ['laris', 'Laris', ' '],
      fits: A14,
    });
    expect(await item(h, itemId)).toMatchObject({
      name: 'LCD Samsung Galaxy A14/A14 5G Original + frame',
      nameAuto: true,
      categoryId,
      values: { q: ['Original'], x: ['+ frame'] },
      tags: ['laris'],
    });
  });

  test('archiving from the item screen keeps everything else about it', async () => {
    const h = await harness(7204);
    const categoryId = await addCategory(h);
    const itemId = await addItem(h, {
      nameAuto: true,
      categoryId,
      values: { q: ['OEM'], x: ['+ frame'] },
      tags: ['laris'],
      barcode: '8990001',
      code: 'L-A14',
      fits: A14,
    });
    const before = (await item(h, itemId)) as unknown as ItemDetailRow;
    await h.runInventory(
      'editItem',
      { itemId, archived: true, ...itemDetails(before) },
      h.storeOwnerId,
    );
    const { name, nameAuto, code, barcode, values, tags, models } = before;
    expect(await item(h, itemId)).toMatchObject({
      archived: true,
      name,
      nameAuto,
      code,
      barcode,
      categoryId,
      values,
      tags,
      models,
    });
  });

  test('a typed name stays as typed', async () => {
    const h = await harness(7202);
    const categoryId = await addCategory(h);
    const itemId = await addItem(h, {
      name: 'LCD A14 copotan',
      categoryId,
      values: { q: ['KW'] },
    });
    expect(await item(h, itemId)).toMatchObject({ name: 'LCD A14 copotan', nameAuto: false });
  });

  test('a new format renames the items it named, not the ones typed by hand', async () => {
    const h = await harness(7203);
    const categoryId = await addCategory(h);
    const auto = await addItem(h, {
      nameAuto: true,
      categoryId,
      values: { q: ['OEM'] },
      fits: A14,
    });
    const typed = await addItem(h, { name: 'LCD A14 copotan', categoryId, values: { q: ['KW'] } });

    const fields = LCD_FIELDS.map((f) => (f.id === 'q' ? { ...f, label: 'Grade' } : f));
    const result = (await h.runInventory(
      'editCategory',
      {
        categoryId,
        ...LCD,
        fields,
        nameFormat: 'LCD {Grade} {HP}',
        archived: false,
      },
      h.ownerId,
    )) as { renamed: number };

    expect(result.renamed).toBe(1);
    expect((await item(h, auto))['name']).toBe('LCD OEM Samsung Galaxy A14/A14 5G');
    expect((await item(h, typed))['name']).toBe('LCD A14 copotan');
  });
});

describe('finding items', () => {
  async function shelf(h: RepairHarness) {
    const lcd = await addCategory(h);
    const charger = await addCategory(h, {
      name: 'Charger',
      isPart: false,
      fields: [{ id: 'w', label: 'Watt', kind: 'one', options: ['18W', '33W'] }],
      nameFormat: 'Charger {Watt}',
    });
    const a14 = await addItem(h, {
      nameAuto: true,
      categoryId: lcd,
      values: { q: ['Original'], x: ['+ frame'] },
      tags: ['laris'],
      fits: A14,
      barcode: '8991234567890',
    });
    const a14kw = await addItem(h, {
      nameAuto: true,
      categoryId: lcd,
      values: { q: ['KW'] },
      fits: A14,
    });
    const fast = await addItem(h, {
      nameAuto: true,
      categoryId: charger,
      values: { w: ['33W'] },
      tags: ['Laris'],
    });
    const glue = await addItem(h, { name: 'Lem B7000' });
    await h.runInventory('countStock', { counts: [{ itemId: a14, counted: 2 }] }, h.storeOwnerId);
    return { lcd, charger, a14, a14kw, fast, glue };
  }

  test('by category, field values, tags and stock', async () => {
    const h = await harness(7301);
    const { lcd } = await shelf(h);
    expect(await names(h, { categoryId: lcd })).toStrictEqual([
      'LCD Samsung Galaxy A14/A14 5G KW',
      'LCD Samsung Galaxy A14/A14 5G Original + frame',
    ]);
    expect(await names(h, { categoryId: lcd, values: { q: ['original', 'oem'] } })).toStrictEqual([
      'LCD Samsung Galaxy A14/A14 5G Original + frame',
    ]);
    expect(await names(h, { tags: ['LARIS'] })).toStrictEqual([
      'Charger 33W',
      'LCD Samsung Galaxy A14/A14 5G Original + frame',
    ]);
    expect(await names(h, { categoryId: 'none' })).toStrictEqual(['Lem B7000']);
    expect(await names(h, { filter: 'outOfStock', categoryId: lcd })).toStrictEqual([
      'LCD Samsung Galaxy A14/A14 5G KW',
    ]);
  });

  test('the take step offers spareparts only: sparepart categories and items in none', async () => {
    const h = await harness(7302);
    await shelf(h);
    expect(await names(h, { partsOnly: true })).toStrictEqual([
      'LCD Samsung Galaxy A14/A14 5G KW',
      'LCD Samsung Galaxy A14/A14 5G Original + frame',
      'Lem B7000',
    ]);
  });

  test('typed search reaches field values and tags, typos and all', async () => {
    const h = await harness(7303);
    await shelf(h);
    expect((await names(h, { text: 'lcd a14 orignal' }))[0]).toBe(
      'LCD Samsung Galaxy A14/A14 5G Original + frame',
    );
    expect(await names(h, { text: 'laris' })).toContain('Charger 33W');
  });

  test('a scanned code finds its item exactly, never a near miss', async () => {
    const h = await harness(7304);
    const { a14 } = await shelf(h);
    const found = await h.queryInventory('findByCode', { code: '8991234567890' }, h.technicianId);
    expect(found.rows.map((row) => row['id'])).toStrictEqual([a14]);
    const near = await h.queryInventory('findByCode', { code: '8991234567891' }, h.technicianId);
    expect(near.rows).toStrictEqual([]);
  });

  test('the values in use, most used first, for filters and a field’s choices', async () => {
    const h = await harness(7305);
    const { lcd } = await shelf(h);
    const values = (await h.queryInventory('facetValues', { categoryId: lcd }, h.ownerId)).rows;
    expect(values).toStrictEqual([
      { facet: 'x', value: '+ frame', count: 1 },
      { facet: 'q', value: 'KW', count: 1 },
      { facet: 'tag', value: 'laris', count: 1 },
      { facet: 'q', value: 'Original', count: 1 },
    ]);
    const tags = (await h.queryInventory('facetValues', {}, h.ownerId)).rows.filter(
      (row) => row['facet'] === 'tag',
    );
    expect(tags).toStrictEqual([{ facet: 'tag', value: 'Laris', count: 2 }]);
  });
});
