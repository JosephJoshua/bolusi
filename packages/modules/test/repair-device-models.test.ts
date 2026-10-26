// Model suggestions at intake: the downloaded catalog found with typos and maker codes, models
// learned from this store's intakes, and the warm index following both kinds of change.
import { afterEach, expect, test } from 'vitest';

import { PHONE_MODELS_TABLE } from '../src/repair/index.js';

import { intake, openRepairHarness, type RepairHarness } from './support/repair-harness.js';

const open: RepairHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

interface CatalogEntry {
  id: number;
  brand: string;
  name: string;
  kind?: string;
  announcedYear?: number | null;
  modelCodes?: string;
  photoSha256?: string | null;
  specs?: string;
}

let revision = 0;

/** What the catalog download does: write rows, then report the table changed. */
async function download(h: RepairHarness, entries: readonly CatalogEntry[]): Promise<void> {
  for (const entry of entries) {
    revision += 1;
    await h.db
      .insertInto('phoneModels')
      .values({
        kind: 'phone',
        announcedYear: null,
        modelCodes: '',
        photoSha256: null,
        revision,
        ...entry,
      })
      .execute();
  }
  h.engine.invalidation.emit(new Set([PHONE_MODELS_TABLE]));
}

const CATALOG: CatalogEntry[] = [
  {
    id: 12824,
    brand: 'Samsung',
    name: 'Galaxy A55',
    announcedYear: 2024,
    modelCodes: 'SM-A556B, SM-A556E',
    photoSha256: 'a'.repeat(64),
    specs: JSON.stringify({
      chipset: 'Exynos 1480 (4 nm)',
      colors: 'Awesome Iceblue, Awesome Navy',
    }),
  },
  { id: 12000, brand: 'Samsung', name: 'Galaxy A54', announcedYear: 2023, specs: '{"bogus":1}' },
  { id: 12010, brand: 'Infinix', name: 'Note 40', announcedYear: 2024 },
  { id: 12011, brand: 'Tecno', name: 'Note 40', announcedYear: 2024 },
  { id: 12600, brand: 'Xiaomi', name: 'Redmi Note 13', announcedYear: 2023 },
  { id: 13000, brand: 'Apple', name: 'iPhone 16', announcedYear: 2024 },
];

async function suggest(h: RepairHarness, text: string) {
  return (await h.query('searchDeviceModels', { text }, h.cashierId)).rows;
}

test('catalog models are found despite typos and by maker code, with their photo', async () => {
  const h = await openRepairHarness(501);
  open.push(h);
  await download(h, CATALOG);

  const rows = await suggest(h, 'samsng a55');
  expect(rows[0]).toEqual({
    key: 'c:12824',
    brand: 'Samsung',
    model: 'Galaxy A55',
    kind: 'phone',
    announcedYear: 2024,
    photo: { modelId: 12824, sha256: 'a'.repeat(64) },
    specs: {},
    learned: false,
  });
  expect((await suggest(h, 'redmi note13'))[0]).toMatchObject({ model: 'Redmi Note 13' });
  expect((await suggest(h, 'A556'))[0]).toMatchObject({ key: 'c:12824' });
  expect((await suggest(h, 'iphon 16'))[0]).toMatchObject({ brand: 'Apple', model: 'iPhone 16' });
  expect(await suggest(h, 'zzzz qqqq')).toEqual([]);
});

test('a model taken in once is suggested afterwards, unless the catalog already has it', async () => {
  const h = await openRepairHarness(502);
  open.push(h);
  await download(h, CATALOG);
  // Warm the index before the intakes, so they reach it as changes, not a reload.
  expect(await suggest(h, 'evercoss')).toEqual([]);

  await h.run(
    'openTicket',
    intake(h, {
      device: { brand: 'Evercoss', model: 'Xtream 1 Plus', color: 'Hitam', imei: null },
    }),
    h.cashierId,
  );
  await h.run(
    'openTicket',
    intake(h, { device: { brand: 'samsung', model: 'A55', color: 'Biru', imei: null } }),
    h.cashierId,
  );

  expect(await suggest(h, 'evercos xtream')).toEqual([
    {
      key: 'l:["Evercoss","Xtream 1 Plus"]',
      brand: 'Evercoss',
      model: 'Xtream 1 Plus',
      kind: null,
      announcedYear: null,
      photo: null,
      specs: {},
      learned: true,
    },
  ]);
  // "samsung A55" is the catalog's Galaxy A55: suggested once, as the catalog model.
  const a55 = (await suggest(h, 'samsung a55')).filter((row) => /a55/i.test(row.model));
  expect(a55.map((row) => row.key)).toEqual(['c:12824']);
});

test('a catalog download reaches a warm index', async () => {
  const h = await openRepairHarness(503);
  open.push(h);
  expect(await suggest(h, 'galaxy a55')).toEqual([]);
  await download(h, CATALOG);
  expect((await suggest(h, 'galaxy a55'))[0]).toMatchObject({ key: 'c:12824' });
});

test('a ticket finds its catalog model only by an exact spelling, for its photo', async () => {
  const h = await openRepairHarness(504);
  open.push(h);
  await download(h, CATALOG);
  const find = async (brand: string, model: string) =>
    (await h.query('findDeviceModel', { brand, model }, h.cashierId)).rows.map((r) => r.key);

  expect(await find('Samsung', 'Galaxy A55')).toEqual(['c:12824']);
  expect(await find('samsung', 'A55')).toEqual(['c:12824']);
  expect(await find('SAMSUNG', 'galaxy-a55')).toEqual(['c:12824']);
  expect(await find('Samsung', 'A5')).toEqual([]);
  expect(await find('Samsung', '')).toEqual([]);
});

test('without a brand, a model name that names one catalog model finds it, for the brand', async () => {
  const h = await openRepairHarness(506);
  open.push(h);
  await download(h, CATALOG);
  const find = async (model: string) =>
    (await h.query('findDeviceModel', { brand: '', model }, h.cashierId)).rows;

  expect((await find('Galaxy A55')).map((r) => r.brand)).toEqual(['Samsung']);
  expect((await find('samsung a55')).map((r) => r.key)).toEqual(['c:12824']);
  expect((await find('iphone 16')).map((r) => r.brand)).toEqual(['Apple']);
  // Two brands sell a "Note 40": not one model, so no brand is guessed.
  expect(await find('Note 40')).toEqual([]);
  expect(await find('Galaxy A5')).toEqual([]);
});

test('the found model carries its specs, and a spec sheet that does not parse reads as none', async () => {
  const h = await openRepairHarness(507);
  open.push(h);
  await download(h, CATALOG);
  const specs = async (brand: string, model: string) =>
    (await h.query('findDeviceModel', { brand, model }, h.cashierId)).rows[0]!.specs;

  expect(await specs('Samsung', 'Galaxy A55')).toEqual({
    chipset: 'Exynos 1480 (4 nm)',
    colors: 'Awesome Iceblue, Awesome Navy',
  });
  expect(await specs('Samsung', 'Galaxy A54')).toEqual({});
});

test('only staff who take in devices get suggestions', async () => {
  const h = await openRepairHarness(505);
  open.push(h);
  await download(h, CATALOG);
  await expect(h.query('searchDeviceModels', { text: 'a55' }, h.technicianId)).rejects.toThrow();
});
