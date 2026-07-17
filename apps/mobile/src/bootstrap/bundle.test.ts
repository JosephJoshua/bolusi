// The `BundleRefreshPort` producer (api/02-auth §5.2) — the fetch half task 14 did not ship.
//
// Driven against a REAL client DB (better-sqlite3 behind the shim dialect + real migrations), so
// "the bundle was applied" is read out of the directory tables `applyBundle` actually writes, not
// asserted against a mock. `fetch` is injected; no socket opens (T-6/T-7).
//
// THE ONE BEHAVIOUR THIS FILE EXISTS FOR: 304 is a SUCCESS. A steady-state device gets one every
// cycle, and a producer that threw on it would live in permanent backoff (03 §10). That is asserted
// here and falsified at the loop level (sync-client.test.ts).
import { readMeta, readTenantId, SyncTransportError } from '@bolusi/core';
import { closeClientDb, openClientDb, runClientMigrations, type ClientDb } from '@bolusi/db-client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { openBetterSqlite3Driver } from '../../test/better-sqlite3-driver.js';
import { BUNDLE_ETAG_META_KEY, createFetchBundleRefresh } from './bundle.js';

const KEY = 'a'.repeat(64);
const keyStore = { getDatabaseEncryptionKey: () => Promise.resolve(KEY) };

const BUNDLE = {
  tenant: { id: 'tenant-1', name: 'Bolusi Papua' },
  store: { id: 'store-1', name: 'Toko Jayapura' },
  settings: { idleLockSeconds: 300 },
  users: [],
  rolesSnapshot: [],
  permissionsSnapshot: [],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let db: ClientDb;

beforeEach(async () => {
  await closeClientDb(); // the one-connection rule is global (08 §2.2)
  db = await openClientDb({
    driverFactory: openBetterSqlite3Driver,
    keyStore,
    location: ':memory:',
  });
  await runClientMigrations(db.driver, { now: () => 1 });
});

afterEach(async () => {
  await closeClientDb();
});

function producer(fetchImpl: typeof fetch, token: string | null = 'bdt_secret') {
  return createFetchBundleRefresh({
    baseUrl: 'https://api.example.com',
    deviceToken: () => Promise.resolve(token),
    db,
    fetchImpl,
  });
}

describe('the conditional GET /v1/devices/me/bundle (api/02-auth §5.2)', () => {
  test('200 APPLIES the bundle and stores the ETag, returns "refreshed"', async () => {
    const doFetch = vi.fn(async () =>
      jsonResponse(200, { bundle: BUNDLE, etag: 'etag-2', serverTime: 5 }),
    );

    await expect(producer(doFetch as unknown as typeof fetch).refresh()).resolves.toBe('refreshed');

    // Read the RESULT out of the directory the apply actually wrote — not a spy on applyBundle.
    expect(await readTenantId(db.db)).toBe('tenant-1');
    expect(await readMeta(db.db, BUNDLE_ETAG_META_KEY)).toBe('etag-2');

    const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/devices/me/bundle');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer bdt_secret');
    // No stored ETag on a fresh device ⇒ no conditional header on the first fetch.
    expect((init.headers as Record<string, string>)['If-None-Match']).toBeUndefined();
  });

  test('304 is a SUCCESS — resolves "unchanged" and touches NOTHING (the steady state)', async () => {
    // Seed a prior refresh's state, then a 304 must leave both the directory and the ETag untouched.
    const first = vi.fn(async () =>
      jsonResponse(200, { bundle: BUNDLE, etag: 'etag-1', serverTime: 1 }),
    );
    await producer(first as unknown as typeof fetch).refresh();

    const notModified = vi.fn(async () => new Response(null, { status: 304 }));
    await expect(producer(notModified as unknown as typeof fetch).refresh()).resolves.toBe(
      'unchanged',
    );

    // The stored ETag is sent as If-None-Match, and nothing changed.
    const init = (notModified.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)['If-None-Match']).toBe('etag-1');
    expect(await readMeta(db.db, BUNDLE_ETAG_META_KEY)).toBe('etag-1');
    expect(await readTenantId(db.db)).toBe('tenant-1');
  });

  test('a 5xx failure throws SyncTransportError carrying the envelope code (→ backoff, 03 §10)', async () => {
    const doFetch = vi.fn(async () =>
      jsonResponse(503, { error: { code: 'INTERNAL', message: 'down' } }),
    );

    await expect(producer(doFetch as unknown as typeof fetch).refresh()).rejects.toMatchObject({
      code: 'INTERNAL',
      status: 503,
    });
  });

  test('401 DEVICE_REVOKED carries the code VERBATIM — the loop disables on this one, not backs off', async () => {
    // The bundle path must discriminate on the code exactly as the sync transport does: a revoked
    // device gets DEVICE_REVOKED here too, and the loop's `isDeviceRevoked` keys on it (loop.ts).
    const doFetch = vi.fn(async () =>
      jsonResponse(401, { error: { code: 'DEVICE_REVOKED', message: 'revoked' } }),
    );

    const error = await producer(doFetch as unknown as typeof fetch)
      .refresh()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncTransportError);
    expect((error as SyncTransportError).code).toBe('DEVICE_REVOKED');
  });

  test('no device token ⇒ AUTH_TOKEN_MISSING and NOTHING is fetched (fail closed)', async () => {
    const doFetch = vi.fn(async () => jsonResponse(200, {}));

    await expect(
      producer(doFetch as unknown as typeof fetch, null).refresh(),
    ).rejects.toMatchObject({ code: 'AUTH_TOKEN_MISSING', status: null });
    expect(doFetch).not.toHaveBeenCalled();
  });

  test('a "refreshed" fires onBundleRefreshed; a "304" does NOT (the memo-invalidation seam)', async () => {
    const onBundleRefreshed = vi.fn();
    const refreshed = vi.fn(async () =>
      jsonResponse(200, { bundle: BUNDLE, etag: 'etag-9', serverTime: 2 }),
    );
    await createFetchBundleRefresh({
      baseUrl: 'https://api.example.com',
      deviceToken: () => Promise.resolve('bdt_secret'),
      db,
      onBundleRefreshed,
      fetchImpl: refreshed as unknown as typeof fetch,
    }).refresh();
    expect(onBundleRefreshed).toHaveBeenCalledTimes(1);

    const notModified = vi.fn(async () => new Response(null, { status: 304 }));
    await createFetchBundleRefresh({
      baseUrl: 'https://api.example.com',
      deviceToken: () => Promise.resolve('bdt_secret'),
      db,
      onBundleRefreshed,
      fetchImpl: notModified as unknown as typeof fetch,
    }).refresh();
    // Still once — a 304 wrote no directory table, so there is nothing to invalidate.
    expect(onBundleRefreshed).toHaveBeenCalledTimes(1);
  });
});
