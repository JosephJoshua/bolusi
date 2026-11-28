// The repair price list through the real runtime: who may change the business's list and who may
// only price this store apart, what a saved row must name, how the counter finds a row by a phone
// typed loosely, and the PC sheet's reading of a pasted row.
import { afterEach, beforeAll, describe, expect, test } from 'vitest';

import { DomainError, refusalKeyOf } from '@bolusi/core';
import { initI18n } from '@bolusi/i18n';
import idCatalog from '../repair/i18n/id.json' with { type: 'json' };
import enCatalog from '../repair/i18n/en.json' with { type: 'json' };
import type { FitMatch } from '../src/inventory/bulk-entry.js';
import { registerRepairCatalog } from '../src/repair/i18n.js';
import { readPriceRow, repeatedRows, type PriceRowContext } from '../src/repair/price-sheet.js';
import { priceAbilities, priceModelsText, repeatedModels } from '../src/repair/price-terms.js';

import { openRepairHarness, type RepairHarness } from './support/repair-harness.js';

beforeAll(() => {
  initI18n({ locale: 'id' });
  registerRepairCatalog({ id: idCatalog, en: enCatalog });
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

async function expectFailure(p: Promise<unknown>, codeOrRefusal: string): Promise<void> {
  const err = await p.then(
    () => new Error(`expected ${codeOrRefusal}, but the call resolved`),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  const e = err as DomainError;
  expect([e.code, refusalKeyOf(e)]).toContain(
    /^[A-Z_]+$/.test(codeOrRefusal) ? codeOrRefusal : `repair.refusal.${codeOrRefusal}`,
  );
}

const LCD_A12 = {
  repairType: 'screen',
  models: [
    { brand: 'Samsung', model: 'Galaxy A12' },
    { brand: 'Samsung', model: 'Galaxy A12s' },
  ],
  quality: 'Ori',
  amount: 450_000,
};
const BATTERY_NOTE10 = {
  repairType: 'battery',
  models: [{ brand: 'Xiaomi', model: 'Redmi Note 10' }],
  quality: '',
  amount: 150_000,
};

async function saveRows(h: RepairHarness, rows: readonly object[]): Promise<string[]> {
  const out = (await h.run('savePrices', { rows } as never, h.ownerId)) as {
    priceIds: string[];
  };
  return out.priceIds;
}

async function list(h: RepairHarness, input: object = {}, userId = h.cashierId) {
  return (
    await h.query(
      'priceList',
      { text: '', repairType: null, offset: 0, limit: 50, ...input },
      userId,
    )
  ).rows;
}

describe('the business list', () => {
  test('the owner saves rows; every store reads them in the order of the repair type list', async () => {
    const h = await harness(1);
    const [lcd, battery] = await saveRows(h, [LCD_A12, BATTERY_NOTE10]);
    const rows = await list(h);
    // The built-in list has the screen before the battery.
    expect(rows.map((r: { id: string }) => r.id)).toStrictEqual([lcd, battery]);
    expect(rows[0]).toMatchObject({
      repairType: 'screen',
      quality: 'Ori',
      listAmount: 450_000,
      storeAmount: null,
      amount: 450_000,
    });
    expect(rows[0].models).toStrictEqual(LCD_A12.models);
  });

  test('editing keeps the row; removing hides it', async () => {
    const h = await harness(2);
    const [lcd] = await saveRows(h, [LCD_A12]);
    const again = await saveRows(h, [{ ...LCD_A12, priceId: lcd, amount: 475_000 }]);
    expect(again).toStrictEqual([lcd]);
    expect((await list(h))[0]).toMatchObject({ id: lcd, amount: 475_000 });

    await h.run('removePrices', { priceIds: [lcd!] }, h.ownerId);
    expect(await list(h)).toStrictEqual([]);
    await expectFailure(h.run('removePrices', { priceIds: [lcd!] }, h.ownerId), 'priceNotFound');
  });

  test('only the business owner changes the list', async () => {
    const h = await harness(3);
    for (const userId of [h.cashierId, h.storeOwnerId, h.managerId]) {
      await expectFailure(
        h.run('savePrices', { rows: [LCD_A12] } as never, userId),
        'PERMISSION_DENIED',
      );
    }
  });

  test('a row names a repair type the business has', async () => {
    const h = await harness(4);
    await expectFailure(saveRows(h, [{ ...LCD_A12, repairType: 'teleport' }]), 'priceRepairType');
  });

  test('a price is more than nothing and names at least one phone', async () => {
    const h = await harness(5);
    await expectFailure(saveRows(h, [{ ...LCD_A12, amount: 0 }]), 'VALIDATION_FAILED');
    await expectFailure(saveRows(h, [{ ...LCD_A12, models: [] }]), 'VALIDATION_FAILED');
  });
});

describe('finding a price', () => {
  test('a phone typed loosely finds its row first; a type chip narrows the list', async () => {
    const h = await harness(6);
    const [lcd, battery] = await saveRows(h, [LCD_A12, BATTERY_NOTE10]);
    const found = await list(h, { text: 'redmi not 10' });
    expect(found[0].id).toBe(battery);
    expect(
      (await list(h, { repairType: 'screen' })).map((r: { id: string }) => r.id),
    ).toStrictEqual([lcd]);
  });

  test('a phone written another way still finds its exact rows', async () => {
    const h = await harness(7);
    const [lcd] = await saveRows(h, [LCD_A12, BATTERY_NOTE10]);
    const rows = (
      await h.query(
        'pricesForModels',
        { models: [{ brand: 'Samsung', model: 'A12' }], repairType: null },
        h.cashierId,
      )
    ).rows;
    expect(rows.map((r: { id: string }) => r.id)).toStrictEqual([lcd]);
  });
});

describe("a store's own price", () => {
  test('the store owner prices this store apart, and clears it back to the list', async () => {
    const h = await harness(8);
    const [lcd] = await saveRows(h, [LCD_A12]);
    await h.run('setStorePrices', { prices: [{ priceId: lcd!, amount: 500_000 }] }, h.storeOwnerId);
    expect((await list(h))[0]).toMatchObject({
      listAmount: 450_000,
      storeAmount: 500_000,
      amount: 500_000,
    });

    await h.run('setStorePrices', { prices: [{ priceId: lcd!, amount: null }] }, h.storeOwnerId);
    expect((await list(h))[0]).toMatchObject({ storeAmount: null, amount: 450_000 });
  });

  test('the counter may not set it, and it must point at a price that exists', async () => {
    const h = await harness(9);
    const [lcd] = await saveRows(h, [LCD_A12]);
    await expectFailure(
      h.run('setStorePrices', { prices: [{ priceId: lcd!, amount: 1 }] }, h.cashierId),
      'PERMISSION_DENIED',
    );
    await expectFailure(
      h.run(
        'setStorePrices',
        { prices: [{ priceId: '01900000-0000-7000-8000-00000000abcd', amount: 1 }] },
        h.storeOwnerId,
      ),
      'priceNotFound',
    );
  });

  test("the counter's list leaves out the repair types this store hides", async () => {
    const h = await harness(11);
    const [lcd, battery] = await saveRows(h, [LCD_A12, BATTERY_NOTE10]);
    await h.run('hideIntakeOptions', { list: 'repairTypes', hidden: ['battery'] }, h.storeOwnerId);
    const ids = async (storeOnly: boolean) =>
      (await list(h, { storeOnly })).map((r: { id: string }) => r.id);
    expect(await ids(true)).toStrictEqual([lcd]);
    expect(await ids(false)).toStrictEqual([lcd, battery]);
  });

  test('who sees what on the list', async () => {
    const h = await harness(10);
    const of = (userId: string) => priceAbilities((p) => h.hasPermission(userId, p));
    expect(of(h.ownerId)).toMatchObject({ edit: true, store: true });
    expect(of(h.storeOwnerId)).toMatchObject({ edit: false, store: true });
    expect(of(h.cashierId)).toMatchObject({ edit: false, store: false });
  });
});

describe('the PC sheet', () => {
  const types = [
    { id: 'screen', label: 'Ganti LCD' },
    { id: 'battery', label: 'Ganti baterai' },
  ];
  const catalog: Record<string, FitMatch> = {
    a12: { exact: { brand: 'Samsung', model: 'Galaxy A12' }, near: null },
    a13: { exact: { brand: 'Samsung', model: 'Galaxy A13' }, near: null },
    'a12 x': { exact: null, near: { brand: 'Samsung', model: 'Galaxy A12' } },
  };
  const ctx = (strict = false, storeColumn = false): PriceRowContext => ({
    types,
    fit: (typed) => catalog[typed.toLowerCase()],
    storeColumn,
    strict,
  });

  test('a pasted row reads into a ready price with the catalog spelling', () => {
    const row = readPriceRow(
      { type: 'ganti lcd', models: 'A12, a13, A12', quality: ' Ori ', amount: 'Rp 450.000' },
      ctx(),
    );
    expect(row).toMatchObject({
      ready: true,
      repairType: 'screen',
      quality: 'Ori',
      amount: 450_000,
      storeAmount: null,
    });
    expect(row.models).toStrictEqual([
      { brand: 'Samsung', model: 'Galaxy A12' },
      { brand: 'Samsung', model: 'Galaxy A13' },
    ]);
  });

  test('what is wrong is said in its cell; missing cells only once saving was tried', () => {
    const typing = readPriceRow({ type: '', models: 'A12', amount: '' }, ctx());
    expect(typing.problems).toStrictEqual({});
    expect(typing.ready).toBe(false);

    const saving = readPriceRow({ type: '', models: 'A12', amount: '' }, ctx(true));
    expect(Object.keys(saving.problems).sort()).toStrictEqual(['amount', 'type']);

    const bad = readPriceRow({ type: 'Teleport', models: 'A12', amount: '45O.000' }, ctx());
    expect(bad.problems.type?.tone).toBe('danger');
    expect(bad.problems.amount?.tone).toBe('danger');
  });

  test('a phone not in the catalog is kept as typed with a warning that names the near one', () => {
    const row = readPriceRow({ type: 'Ganti LCD', models: 'A12 x', amount: '450000' }, ctx());
    expect(row.ready).toBe(true);
    expect(row.models).toStrictEqual([{ brand: '', model: 'A12 x' }]);
    expect(row.problems.models).toMatchObject({ tone: 'warning' });
    expect(row.problems.models?.message).toContain('Galaxy A12');
  });

  test('the store column is read only when it is on the sheet', () => {
    const cells = { type: 'Ganti LCD', models: 'A12', amount: '450000', store: '500.000' };
    expect(readPriceRow(cells, ctx()).storeAmount).toBeNull();
    expect(readPriceRow(cells, ctx(false, true)).storeAmount).toBe(500_000);
    expect(readPriceRow({ store: '9' }, ctx()).filled).toBe(false);
  });

  test('a phone priced twice for the same repair and quality points at the first row', () => {
    const a = readPriceRow({ type: 'Ganti LCD', models: 'A12, A13', amount: '1' }, ctx());
    const b = readPriceRow({ type: 'Ganti LCD', models: 'A13', amount: '2' }, ctx());
    const other = readPriceRow(
      { type: 'Ganti LCD', models: 'A13', quality: 'KW', amount: '2' },
      ctx(),
    );
    const found = repeatedRows([
      { id: 'a', read: a },
      { id: 'b', read: b },
      { id: 'c', read: other },
    ]);
    expect([...found.keys()]).toStrictEqual(['b']);
    expect(found.get('b')).toStrictEqual({ model: 'Samsung Galaxy A13', row: 1 });
  });

  test('the phone form names the phones another row already prices', () => {
    const repeated = repeatedModels(
      { repairType: 'screen', quality: 'ori', models: [{ brand: 'Samsung', model: 'A12' }] },
      [
        {
          id: 'x',
          repairType: 'screen',
          quality: 'Ori',
          models: [{ brand: 'Samsung', model: 'Galaxy A12' }],
          listAmount: 1,
          storeAmount: null,
          amount: 1,
          updatedAt: 0,
        },
      ],
      null,
    );
    expect(repeated).toHaveLength(1);
  });
});

test('a row names each brand once for its run of phones', () => {
  expect(
    priceModelsText([
      { brand: 'Samsung', model: 'Galaxy A12' },
      { brand: 'Samsung', model: 'Galaxy M12' },
      { brand: 'Oppo', model: 'A16' },
      { brand: '', model: 'A12 x' },
    ]),
  ).toBe('Samsung Galaxy A12, Galaxy M12, Oppo A16, A12 x');
});
