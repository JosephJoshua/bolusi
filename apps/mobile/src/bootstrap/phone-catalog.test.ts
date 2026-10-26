// The phone catalog download against a real client DB: paging by revision, resuming after a
// failure, updating changed rows, and telling the model search its table changed.
import { InvalidationBus, readMeta } from '@bolusi/core';
import { closeClientDb, openClientDb, runClientMigrations, type ClientDb } from '@bolusi/db-client';
import type { PhoneModel } from '@bolusi/schemas';
import { nodeColumnAead } from '@bolusi/test-support';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { openBetterSqlite3Driver } from '../../test/better-sqlite3-driver.js';
import {
  PHONE_CATALOG_CHECK_EVERY_MS,
  PHONE_CATALOG_REVISION_KEY,
  createPhoneCatalogRefresher,
} from './phone-catalog.js';

let db: ClientDb;

beforeEach(async () => {
  await closeClientDb();
  db = await openClientDb({
    driverFactory: openBetterSqlite3Driver,
    keyStore: { getDatabaseEncryptionKey: () => Promise.resolve('a'.repeat(64)) },
    aead: nodeColumnAead,
    location: ':memory:',
  });
  await runClientMigrations(db.driver, { now: () => 1 });
});

afterEach(async () => {
  await closeClientDb();
});

function model(id: number, patch: Partial<PhoneModel> = {}): PhoneModel {
  return {
    id,
    brand: 'Samsung',
    name: `Galaxy A${id}`,
    kind: 'phone',
    announcedYear: 2024,
    modelCodes: '',
    photoSha256: null,
    revision: id,
    ...patch,
  };
}

/** A fake server holding `models`, two per page; `fail` makes the next request a 503. */
function server(models: PhoneModel[]) {
  const requests: string[] = [];
  const state = { fail: false, models };
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(`${url.pathname}${url.search}`);
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer bdt_secret');
    if (state.fail) {
      state.fail = false;
      return new Response(JSON.stringify({ error: { code: 'INTERNAL' } }), { status: 503 });
    }
    const after = Number(url.searchParams.get('after'));
    const rest = state.models.filter((m) => m.revision > after);
    return new Response(JSON.stringify({ models: rest.slice(0, 2), more: rest.length > 2 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { requests, state, fetchImpl };
}

function refresher(fetchImpl: typeof fetch, now: { value: number }, bus = new InvalidationBus()) {
  return createPhoneCatalogRefresher({
    baseUrl: 'https://api.example.com',
    deviceToken: () => Promise.resolve('bdt_secret'),
    db,
    invalidation: bus,
    clock: { now: () => now.value },
    fetchImpl,
  });
}

const stored = () => db.db.selectFrom('phoneModels').selectAll().orderBy('id').execute();

test('downloads every page and tells the search its table changed', async () => {
  const { requests, fetchImpl } = server([1, 2, 3, 4, 5].map((id) => model(id)));
  const bus = new InvalidationBus();
  const changed: string[][] = [];
  bus.subscribe((tables) => changed.push([...tables]));
  const now = { value: PHONE_CATALOG_CHECK_EVERY_MS };

  expect(await refresher(fetchImpl, now, bus).refreshIfDue()).toBe('updated');
  expect(requests).toEqual([
    '/v1/catalog/phones?after=0',
    '/v1/catalog/phones?after=2',
    '/v1/catalog/phones?after=4',
  ]);
  expect((await stored()).map((row) => row.id)).toEqual([1, 2, 3, 4, 5]);
  expect(await readMeta(db.db, PHONE_CATALOG_REVISION_KEY)).toBe('5');
  expect(changed).toEqual([['phone_models'], ['phone_models'], ['phone_models']]);
});

test('checks again only when due, and then fetches just the changes', async () => {
  const { requests, state, fetchImpl } = server([model(1), model(2)]);
  const now = { value: PHONE_CATALOG_CHECK_EVERY_MS };
  const catalog = refresher(fetchImpl, now);
  await catalog.refreshIfDue();

  now.value += PHONE_CATALOG_CHECK_EVERY_MS - 1;
  expect(await catalog.refreshIfDue()).toBe('not-due');

  now.value += 1;
  state.models = [
    model(1),
    model(2),
    model(1, { name: 'Galaxy A1 5G', photoSha256: 'c'.repeat(64), revision: 3 }),
  ];
  requests.length = 0;
  expect(await catalog.refreshIfDue()).toBe('updated');
  expect(requests).toEqual(['/v1/catalog/phones?after=2']);
  expect((await stored())[0]).toMatchObject({
    id: 1,
    name: 'Galaxy A1 5G',
    photoSha256: 'c'.repeat(64),
    revision: 3,
  });

  now.value += PHONE_CATALOG_CHECK_EVERY_MS;
  expect(await catalog.refreshIfDue()).toBe('unchanged');
});

test('a failed page keeps the pages before it and resumes after them', async () => {
  const { requests, state, fetchImpl } = server([1, 2, 3, 4].map((id) => model(id)));
  const now = { value: PHONE_CATALOG_CHECK_EVERY_MS };
  const catalog = refresher(fetchImpl, now);
  const original = fetchImpl;
  let calls = 0;
  const failSecond = (async (input: string | URL, init?: RequestInit) => {
    calls += 1;
    if (calls === 2) state.fail = true;
    return original(input, init);
  }) as typeof fetch;

  await expect(refresher(failSecond, now).refreshIfDue()).rejects.toThrow();
  expect((await stored()).map((row) => row.id)).toEqual([1, 2]);

  requests.length = 0;
  expect(await catalog.refreshIfDue()).toBe('updated');
  expect(requests[0]).toBe('/v1/catalog/phones?after=2');
  expect((await stored()).map((row) => row.id)).toEqual([1, 2, 3, 4]);
});

test('concurrent checks share one download', async () => {
  const { requests, fetchImpl } = server([model(1)]);
  const catalog = refresher(fetchImpl, { value: PHONE_CATALOG_CHECK_EVERY_MS });
  await Promise.all([catalog.refreshIfDue(), catalog.refreshIfDue()]);
  expect(requests).toHaveLength(1);
});
