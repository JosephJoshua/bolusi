import { createHash } from 'node:crypto';

import type { PhoneCatalogWriter } from '@bolusi/db-server';
import { describe, expect, test } from 'vitest';

import { loadCatalogFile, parseCatalogFile } from './catalog-file.js';

const PHOTO = Buffer.from([0xff, 0xd8, 0xff, 7]);
const PHOTO_SHA = createHash('sha256').update(PHOTO).digest('hex');

const brand = { type: 'brand', path: 'samsung-phones-9.php', name: 'Samsung' };
function model(id: number, extra: object = {}) {
  return {
    type: 'model',
    id,
    brand: 'Samsung',
    name: `Galaxy A${id} (2024)`,
    kind: 'phone',
    announcedYear: 2024,
    pagePath: `samsung_galaxy_a${id}_(2024)-${id}.php`,
    photoUrl: `https://fdn2.gsmarena.com/vv/bigpic/a${id}.jpg`,
    ...extra,
  };
}
const file = (...lines: object[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

/** Records what a load asks of the catalog store. */
function recorder() {
  const calls: string[] = [];
  const store: PhoneCatalogWriter = {
    saveBrands: async (brands) => void calls.push(`brands ${brands.map((b) => b.name).join()}`),
    brands: async () => [],
    markBrandListed: async () => {},
    saveListedModels: async (models) => {
      calls.push(`listed ${models.map((m) => m.id).join()}`);
      return models.length;
    },
    modelsNeedingPhoto: async () => [],
    savePhoto: async (id, photo) => void calls.push(`photo ${id} ${photo?.sha256.slice(0, 6)}`),
    removePhoto: async (id) => void calls.push(`no photo ${id}`),
    modelsNeedingDetails: async () => [],
    saveDetails: async (id, details) => void calls.push(`details ${id} ${JSON.stringify(details)}`),
  };
  return { store, calls };
}

describe('a catalog file', () => {
  test('loads brands, then models, then the details and photos it carries', async () => {
    const lines = parseCatalogFile(
      file(
        brand,
        model(1),
        model(2, {
          details: { modelCodes: ['SM-A256B'], specs: { chipset: 'Exynos 1280 (5 nm)' } },
          photo: { mime: 'image/jpeg', sha256: PHOTO_SHA, base64: PHOTO.toString('base64') },
        }),
      ),
    );
    const { store, calls } = recorder();
    const summary = await loadCatalogFile(store, lines, 1000);
    expect(calls).toEqual([
      'brands Samsung',
      'listed 1,2',
      `details 2 ${JSON.stringify({ modelCodes: ['SM-A256B'], specs: { chipset: 'Exynos 1280 (5 nm)' }, announcedYear: 2024 })}`,
      `photo 2 ${PHOTO_SHA.slice(0, 6)}`,
    ]);
    expect(summary).toEqual({ brands: 1, models: 2, newModels: 2, details: 1, photos: 1 });
  });

  test('a names-only model leaves existing details and photos alone', async () => {
    const { store, calls } = recorder();
    await loadCatalogFile(store, parseCatalogFile(file(model(1))), 1000);
    expect(calls).toEqual(['brands ', 'listed 1']);
  });

  test('a model saying it has no photo removes a stored one', async () => {
    const { store, calls } = recorder();
    await loadCatalogFile(store, parseCatalogFile(file(model(1, { photo: null }))), 1000);
    expect(calls).toEqual(['brands ', 'listed 1', 'no photo 1']);
  });

  test.each([
    ['an unknown field', model(1, { colour: 'red' })],
    ['a page path that is not a model page', model(1, { pagePath: '../x-1.php' })],
    ["another model's page path", model(1, { pagePath: 'samsung_galaxy_a2-2.php' })],
    ['a brand page as a model page', model(9, { pagePath: 'samsung-phones-9.php' })],
    ['a plain http photo address', model(1, { photoUrl: 'http://fdn2.gsmarena.com/a.jpg' })],
    ['an unknown spec', model(1, { details: { modelCodes: [], specs: { price: '1' } } })],
  ])('refuses %s', (_, line) => {
    expect(() => parseCatalogFile(file(brand, line))).toThrow(/^line 2: /);
  });

  test('refuses a line that is not JSON', () => {
    expect(() => parseCatalogFile('{"type":\n')).toThrow('line 1: not JSON');
  });

  test('refuses a repeated model', () => {
    expect(() => parseCatalogFile(file(model(1), model(1)))).toThrow('line 2: repeated m:1');
  });

  test('refuses a photo that does not match its hash before writing anything', async () => {
    const bad = model(1, {
      photo: { mime: 'image/png', sha256: 'a'.repeat(64), base64: PHOTO.toString('base64') },
    });
    const { store, calls } = recorder();
    await expect(loadCatalogFile(store, parseCatalogFile(file(bad)), 1000)).rejects.toThrow(
      'model 1: photo does not match its hash',
    );
    expect(calls).toEqual([]);
  });
});
