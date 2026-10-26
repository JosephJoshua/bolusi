// The phone catalog store (migration 0013) on real Postgres: revisions move only when a field a
// device keeps changes, pending work comes newest first, and the app role can read but not write.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
  createPhoneCatalogWriterOn,
  readPhoneModelPhotoFrom,
  readPhoneModelsFrom,
  type ListedPhoneModel,
  type PhoneCatalogWriter,
} from '../src/phone-catalog.js';
import { APP_ROLE } from '../src/schema/security.js';

import { createTestDb, type TestDb } from './helpers/test-db.js';

let testDb: TestDb;
let writer: PhoneCatalogWriter;

beforeAll(async () => {
  testDb = await createTestDb();
  writer = createPhoneCatalogWriterOn(testDb.db);
});

afterAll(async () => {
  await testDb.close();
});

function listed(id: number, patch: Partial<ListedPhoneModel> = {}): ListedPhoneModel {
  return {
    id,
    brand: 'Samsung',
    name: `Galaxy A${id}`,
    kind: 'phone',
    announcedYear: 2024,
    pagePath: `samsung_galaxy_a${id}-${id}.php`,
    photoUrl: `https://fdn2.gsmarena.com/vv/bigpic/samsung-galaxy-a${id}.jpg`,
    ...patch,
  };
}

const read = (after = 0) => readPhoneModelsFrom(testDb.db, after, 100);
const revisionOf = async (id: number) => (await read()).find((row) => row.id === id)!.revision;

describe('revisions', () => {
  test('new models get increasing revisions and read back after a cursor', async () => {
    expect(await writer.saveListedModels([listed(1), listed(2)], 1000)).toBe(2);
    const rows = await read();
    expect(rows.map((row) => row.id)).toEqual([1, 2]);
    expect(rows[0]).toMatchObject({
      brand: 'Samsung',
      name: 'Galaxy A1',
      kind: 'phone',
      announcedYear: 2024,
      modelCodes: '',
      photoSha256: null,
    });
    expect(rows[1]!.revision).toBeGreaterThan(rows[0]!.revision);
    expect(await read(rows[1]!.revision)).toEqual([]);
  });

  test('listing the same model again changes nothing a device keeps', async () => {
    const before = await revisionOf(1);
    expect(await writer.saveListedModels([listed(1)], 2000)).toBe(0);
    expect(await revisionOf(1)).toBe(before);
  });

  test('a renamed model moves to a new revision', async () => {
    const latest = Math.max(...(await read()).map((row) => row.revision));
    await writer.saveListedModels([listed(1, { name: 'Galaxy A1 (2024)' })], 3000);
    const after = await read(latest);
    expect(after.map((row) => [row.id, row.name])).toEqual([[1, 'Galaxy A1 (2024)']]);
  });

  test('the device page year wins over a later listing guess', async () => {
    await writer.saveDetails(
      2,
      { modelCodes: ['SM-A025F', 'SM-A025G'], announcedYear: 2023 },
      4000,
    );
    await writer.saveListedModels([listed(2, { announcedYear: 2024 })], 5000);
    const row = (await read()).find((r) => r.id === 2)!;
    expect(row).toMatchObject({ announcedYear: 2023, modelCodes: 'SM-A025F, SM-A025G' });
  });
});

describe('photos and details', () => {
  test('pending work comes newest first and leaves once done', async () => {
    await writer.saveListedModels(
      [
        listed(10, { announcedYear: 2019 }),
        listed(11, { announcedYear: 2025 }),
        listed(12, { announcedYear: null }),
      ],
      6000,
    );
    const ids = (await writer.modelsNeedingPhoto(100)).map((m) => m.id);
    expect(ids.indexOf(11)).toBeLessThan(ids.indexOf(10));
    expect(ids.indexOf(10)).toBeLessThan(ids.indexOf(12));

    await writer.savePhoto(11, null, 7000);
    expect((await writer.modelsNeedingPhoto(100)).map((m) => m.id)).not.toContain(11);
    expect((await writer.modelsNeedingDetails(100)).map((m) => m.id)).not.toContain(2);
  });

  test('a stored photo is served and bumps the revision once', async () => {
    const photo = { sha256: 'a'.repeat(64), mime: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]) };
    const before = await revisionOf(10);
    await writer.savePhoto(10, photo, 8000);
    const bumped = await revisionOf(10);
    expect(bumped).toBeGreaterThan(before);
    await writer.savePhoto(10, photo, 9000);
    expect(await revisionOf(10)).toBe(bumped);

    const served = await readPhoneModelPhotoFrom(testDb.db, 10);
    expect(served).toEqual(photo);
    expect(await readPhoneModelPhotoFrom(testDb.db, 11)).toBeNull();
  });

  test('a new photo address is fetched again', async () => {
    await writer.saveListedModels(
      [listed(10, { photoUrl: 'https://fdn2.gsmarena.com/vv/bigpic/new.jpg' })],
      10_000,
    );
    expect((await writer.modelsNeedingPhoto(100)).map((m) => m.id)).toContain(10);
  });
});

test('brands remember when their listing was last walked', async () => {
  await writer.saveBrands([{ path: 'samsung-phones-9.php', name: 'Samsung' }]);
  await writer.saveBrands([{ path: 'samsung-phones-9.php', name: 'Samsung' }]);
  expect(await writer.brands()).toEqual([
    { path: 'samsung-phones-9.php', name: 'Samsung', listedAt: null },
  ]);
  await writer.markBrandListed('samsung-phones-9.php', 11_000);
  expect((await writer.brands())[0]!.listedAt).toBe(11_000);
});

test('the app role reads the catalog but cannot change it', async () => {
  await testDb.db.transaction().execute(async (trx) => {
    await sql`SET LOCAL ROLE ${sql.id(APP_ROLE)}`.execute(trx);
    expect((await readPhoneModelsFrom(trx, 0, 1)).length).toBe(1);
  });
  await expect(
    testDb.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE ${sql.id(APP_ROLE)}`.execute(trx);
      await sql`UPDATE phone_models SET name = 'x'`.execute(trx);
    }),
  ).rejects.toThrow(/permission denied/);
});
