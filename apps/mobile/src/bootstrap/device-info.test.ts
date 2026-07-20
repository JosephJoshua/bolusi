// The Settings device-info block, read from PERSISTED state (task 94).
//
// Driven against a REAL client DB (better-sqlite3 behind the shim dialect + real migrations): "the
// value is persisted" is read back out of meta_kv, not asserted against a mock (like bundle.test.ts).
//
// THE BUG THIS GUARDS: index.ts used to hand Root a hardcoded EMPTY deviceInfo, so an enrolled device
// (task 92) rendered every identity field blank. FALSIFIED (§2.11): reverting `readDeviceInfo`'s
// enrolled branch to that empty object turns "an enrolled device shows its real identity" RED; and
// because the enrolled assertion reads back what `persistEnrolledNames` wrote, a persist that used a
// DIFFERENT key than the read (silent drift, T-15) fails here too — the two are asserted to agree.
import { DEVICE_ID_META_KEY, writeMeta } from '@bolusi/core';
import { closeClientDb, openClientDb, runClientMigrations, type ClientDb } from '@bolusi/db-client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { openBetterSqlite3Driver } from '../../test/better-sqlite3-driver.js';

import type { Bootstrapped } from './bootstrap.js';
import { persistEnrolledNames, readDeviceInfo, type DeviceInfoContext } from './device-info.js';

const KEY = 'a'.repeat(64);
const keyStore = { getDatabaseEncryptionKey: () => Promise.resolve(KEY) };

// The process facts index.ts binds. `appVersion` is '' in v0 (expo-constants deferred) — asserted to
// pass through UNCHANGED, so a future non-empty version is not silently dropped.
const CTX: DeviceInfoContext = { platform: 'android', appVersion: '' };

let db: ClientDb;
// `readDeviceInfo`/`persistEnrolledNames` read ONLY `app.db.db` (the Kysely handle), so a real client
// DB wrapped in this shape is a faithful driver for them — the rest of a Bootstrapped is irrelevant.
let app: Bootstrapped;

beforeEach(async () => {
  await closeClientDb(); // the one-connection rule is global (08 §2.2)
  db = await openClientDb({
    driverFactory: openBetterSqlite3Driver,
    keyStore,
    location: ':memory:',
  });
  await runClientMigrations(db.driver, { now: () => 1 });
  app = { db } as unknown as Bootstrapped;
});

afterEach(async () => {
  await closeClientDb();
});

describe('an UNENROLLED device shows the honest empty block, never a fake (task 94)', () => {
  test('every server-established field is empty; platform + appVersion are the process facts', async () => {
    const info = await readDeviceInfo(app, CTX);
    expect(info).toEqual({
      deviceId: '',
      deviceName: '',
      storeName: '',
      tenantName: '',
      platform: 'android',
      appVersion: '',
    });
  });

  test('the context is passed through verbatim — a real appVersion is not dropped', async () => {
    const info = await readDeviceInfo(app, { platform: 'ios', appVersion: '1.4.0' });
    expect(info.platform).toBe('ios');
    expect(info.appVersion).toBe('1.4.0');
  });
});

describe('an ENROLLED device renders its REAL identity from meta_kv (task 94)', () => {
  test('deviceId + the persisted names surface — not one blank among the four an owner revokes by', async () => {
    await writeMeta(db.db, DEVICE_ID_META_KEY, 'device-abc');
    await persistEnrolledNames(app, {
      deviceName: 'Kasir 1',
      storeName: 'Toko Jayapura',
      tenantName: 'Bolusi Papua',
    });

    const info = await readDeviceInfo(app, CTX);
    expect(info.deviceId).toBe('device-abc');
    expect(info.deviceName).toBe('Kasir 1');
    expect(info.storeName).toBe('Toko Jayapura');
    expect(info.tenantName).toBe('Bolusi Papua');
    // The whole point of the task: none of the four is blank on an enrolled device.
    expect([info.deviceId, info.deviceName, info.storeName, info.tenantName]).not.toContain('');
  });

  test('a fresh persist OVERWRITES the prior names (re-enroll to a different store surfaces the new one)', async () => {
    await writeMeta(db.db, DEVICE_ID_META_KEY, 'device-abc');
    await persistEnrolledNames(app, {
      deviceName: 'Old',
      storeName: 'Store A',
      tenantName: 'Tenant A',
    });
    await persistEnrolledNames(app, {
      deviceName: 'New',
      storeName: 'Store B',
      tenantName: 'Tenant B',
    });

    const info = await readDeviceInfo(app, CTX);
    expect(info.deviceName).toBe('New');
    expect(info.storeName).toBe('Store B');
    expect(info.tenantName).toBe('Tenant B');
  });
});
