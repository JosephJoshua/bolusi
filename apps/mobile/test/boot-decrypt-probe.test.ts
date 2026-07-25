// THE BOOT KEY-TAG PROBE (task 160) — "is this database ours?" before boot is declared successful.
//
// Post-D22 the client file is PLAINTEXT and `open()` takes no key, so a restored foreign DB (iOS
// restore-to-new-hardware; Android partial data-clear) OPENS FINE and the old SQLCipher
// `not_a_database` self-heal (recovery.ts) can no longer fire — boot "succeeds" into a SILENT
// half-enrolled state that renders a foreign device's sealed columns as opaque envelope text (the
// bug this task closes; security-guide §6.6). Every test here drives the REAL `bootstrap()` over the
// REAL column cipher (`nodeColumnAead`) through better-sqlite3, the same lane the at-rest suite uses
// to make a wrong-key reopen return envelope text rather than throw. A probe that re-implemented the
// tag would prove only that the probe agrees with itself (T-13), so these run the shipping code.
//
// WHAT THIS LANE CANNOT ANSWER (T-11 / D12/D13): a REAL iOS/Android restore. There is no physical
// device on this infra. What IS proven: the tag mismatch is detected, classified, and routed into the
// existing wipe-and-re-enrol heal — and that a fresh/healthy/transient case is NOT wiped.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  closeClientDb,
  DbError,
  isClientDbOpen,
  toDbError,
  type DbDriver,
  type DbDriverOpenParams,
} from '@bolusi/db-client';
import {
  deleteMeta,
  listSwitcherUsers,
  readMeta,
  replaceUsersDirectory,
  writeMeta,
} from '@bolusi/core';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  setItemAsync: vi.fn(async () => undefined),
  getItemAsync: vi.fn(async () => null),
  deleteItemAsync: vi.fn(async () => undefined),
}));

import * as SecureStore from 'expo-secure-store';

import { bootstrap, type Bootstrapped } from '../src/bootstrap/bootstrap.js';
import { bootWithLocalRecovery, isUnrecoverableLocalDbError } from '../src/bootstrap/recovery.js';
import {
  assertDatabaseKeyBinding,
  DB_CIPHER_KEY_TAG_META_KEY,
  ForeignDatabaseError,
} from '../src/bootstrap/db-identity.js';
import { DB_ENCRYPTION_KEY, SecureStoreDbKeyStore } from '../src/ports/db-keystore.js';
import { openBetterSqlite3Driver } from './better-sqlite3-driver.js';
import { nodeColumnAead } from '@bolusi/test-support';

/** A CSPRNG stand-in that NEVER repeats (T-13): every generated key is distinct, so "the restored key
 * differs from the fresh one" is a real assertion, not an artefact of a constant fake. */
let nonce = 0;
const fakeCrypto = {
  randomBytes: (length: number) => {
    nonce += 1;
    return Uint8Array.from({ length }, (_, i) => (i * 7 + nonce * 31 + 3) & 0xff);
  },
} as unknown as Parameters<typeof bootstrap>[0]['crypto'];

const clock = { now: () => 1_700_000_000_000 };

let tempDir: string;
let secureStore: Map<string, string>;

beforeEach(async () => {
  await closeClientDb(); // the one-connection rule is global — no leaks across tests
  tempDir = mkdtempSync(join(tmpdir(), 'bolusi-probe-160-'));
  secureStore = new Map<string, string>();
  vi.clearAllMocks();
  vi.mocked(SecureStore.getItemAsync).mockImplementation(
    async (k: string) => secureStore.get(k) ?? null,
  );
  vi.mocked(SecureStore.setItemAsync).mockImplementation(async (k: string, v: string) => {
    secureStore.set(k, v);
  });
  vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (k: string) => {
    secureStore.delete(k);
  });
});

afterEach(async () => {
  await closeClientDb();
  rmSync(tempDir, { recursive: true, force: true });
});

/** The REAL bootstrap (real cipher, real migrations, real modules) over a fresh per-boot keystore —
 * exactly as production builds one on every `boot()` (index.ts). */
function boot(location: string): Promise<Bootstrapped> {
  return bootstrap({
    driverFactory: openBetterSqlite3Driver,
    keyStore: new SecureStoreDbKeyStore(fakeCrypto),
    aead: nodeColumnAead,
    crypto: fakeCrypto,
    clock,
    databaseLocation: location,
  });
}

describe('the reproduction, healed: a restored foreign DB is caught at boot and self-heals', () => {
  test('a restored plaintext DB (new key) throws ForeignDatabaseError → wipe + re-enrol, never half-enrolled', async () => {
    const location = join(tempDir, 'restored.db');

    // Device A: an enrolled-ish DB — a device id, some "unsynced work", and a sealed employee name,
    // all under key A. The FIRST boot binds key A's tag into meta_kv (the probe's write-when-absent).
    const first = await boot(location);
    await sql`INSERT INTO meta_kv (key, value) VALUES ('deviceId', 'device-abc')`.execute(
      first.db.db,
    );
    await sql`INSERT INTO meta_kv (key, value) VALUES ('probe', 'unsynced-work')`.execute(
      first.db.db,
    );
    await replaceUsersDirectory(first.db.db, [
      { id: 'user-1', name: 'Budi Santoso', photoMediaId: null, status: 'active' },
    ]);
    await first.close();
    const keyA = secureStore.get(DB_ENCRYPTION_KEY);
    expect(keyA).toMatch(/^[0-9a-f]{64}$/);

    // Restore to new hardware: bolusi.db restores, the THIS_DEVICE_ONLY key does NOT.
    secureStore.clear();

    // The wipe: REAL crypto-erase of the key + delete the DB files (mirrors index.ts's two legs; the
    // sidecar delete is what the existing bootstrap-restore test proves against production).
    const wipeKeyStore = new SecureStoreDbKeyStore(fakeCrypto);
    const wipeLocalData = vi.fn(async () => {
      await wipeKeyStore.wipe();
      for (const f of [location, `${location}-wal`, `${location}-shm`]) rmSync(f, { force: true });
    });

    const healed = await bootWithLocalRecovery({
      boot: () => boot(location),
      wipeLocalData,
    });

    // Recovered to a FRESH, unenrolled app — deviceId null routes to the enrollment wizard, NOT the
    // restored device-abc. This is the un-brick: no silent half-enrolled boot, no envelope-text render.
    expect(healed.deviceId).toBeNull();
    expect(wipeLocalData).toHaveBeenCalledTimes(1);

    // The restored rows are gone (the file was deleted, not adopted).
    const probe = await sql<{
      value: string;
    }>`SELECT value FROM meta_kv WHERE key = 'probe'`.execute(healed.db.db);
    expect(probe.rows).toHaveLength(0);

    // A NEW key was minted for the fresh DB, and its tag is bound (the healed DB is now "ours").
    const keyC = secureStore.get(DB_ENCRYPTION_KEY);
    expect(keyC).toMatch(/^[0-9a-f]{64}$/);
    expect(keyC).not.toBe(keyA);
    expect(await readMeta(healed.db.db, DB_CIPHER_KEY_TAG_META_KEY)).toBe(
      healed.db.columnCipherMarker,
    );
    await healed.close();
  });

  test('the raw boot (no recovery) THROWS ForeignDatabaseError on the restored DB — the producer, not a lookalike', async () => {
    // T-16: pin the classifier to what `bootstrap()` actually throws, not a hand-built error.
    const location = join(tempDir, 'restored-raw.db');
    const first = await boot(location);
    await replaceUsersDirectory(first.db.db, [
      { id: 'user-1', name: 'Budi Santoso', photoMediaId: null, status: 'active' },
    ]);
    await first.close();
    secureStore.clear();

    const err = await boot(location).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ForeignDatabaseError);
    expect(isUnrecoverableLocalDbError(err)).toBe(true);
    // The connection bootstrap opened was closed on the throw (its catch), so a retry can open again.
    expect(isClientDbOpen()).toBe(false);
  });
});

describe('positive controls (all three mandatory — none may be un-failable)', () => {
  test('(a) a fresh EMPTY DB boots normally and is NOT wiped — the tag is bound, deviceId is null', async () => {
    const wipeLocalData = vi.fn(async () => undefined);
    const app = await bootWithLocalRecovery({
      boot: () => boot(':memory:'),
      wipeLocalData,
    });

    expect(wipeLocalData).not.toHaveBeenCalled();
    expect(app.deviceId).toBeNull(); // unenrolled → the wizard, read from the column
    // The probe BOUND the current key's tag on this first boot (write-when-absent).
    expect(await readMeta(app.db.db, DB_CIPHER_KEY_TAG_META_KEY)).toBe(app.db.columnCipherMarker);
    await app.close();
  });

  test('(b) a HEALTHY enrolled DB reopened under the SAME key boots normally and is NOT wiped', async () => {
    const location = join(tempDir, 'healthy.db');
    const first = await boot(location);
    await sql`INSERT INTO meta_kv (key, value) VALUES ('deviceId', 'device-xyz')`.execute(
      first.db.db,
    );
    await replaceUsersDirectory(first.db.db, [
      { id: 'u-1', name: 'Ani Wijaya', photoMediaId: null, status: 'active' },
    ]);
    await first.close();
    // SAME key survives (do NOT clear SecureStore) — this is a normal relaunch.

    const wipeLocalData = vi.fn(async () => undefined);
    const healed = await bootWithLocalRecovery({
      boot: () => boot(location),
      wipeLocalData,
    });

    expect(wipeLocalData).not.toHaveBeenCalled();
    expect(healed.deviceId).toBe('device-xyz'); // the real device, read back — not wiped to null
    // …and the sealed name still DECRYPTS to plaintext (same key), proving the probe passed a real DB.
    const users = await listSwitcherUsers(healed.db.db);
    expect(users.map((u) => u.name)).toEqual(['Ani Wijaya']);
    await healed.close();
  });

  test('(c) a TRANSIENT read failure during the probe SURFACES and does NOT wipe', async () => {
    // The probe's marker read fails transiently (disk I/O). It must surface — a flaky read must never
    // destroy a good DB (recovery.ts's binding rule). The failure is injected at exactly the probe's
    // `meta_kv` read (its bound param is the tag key), leaving migrations and the deviceId read intact.
    const driverFactory = failMarkerReadDriver();
    const wipeLocalData = vi.fn(async () => undefined);

    const err = await bootWithLocalRecovery({
      boot: () =>
        bootstrap({
          driverFactory,
          keyStore: new SecureStoreDbKeyStore(fakeCrypto),
          aead: nodeColumnAead,
          crypto: fakeCrypto,
          clock,
          databaseLocation: ':memory:',
        }),
      wipeLocalData,
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).not.toBeNull();
    expect(err).not.toBeInstanceOf(ForeignDatabaseError); // a read failure is NOT a foreign verdict
    expect(wipeLocalData).not.toHaveBeenCalled(); // the fail-safe: the transient never reached the wipe
  });
});

describe('assertDatabaseKeyBinding — the four-way decision, over a REAL migrated DB', () => {
  /** A fresh migrated DB and the marker of the key that opened it. `boot()` binds the tag; each test
   * resets meta_kv to the state it needs. */
  async function migratedDb(): Promise<Bootstrapped> {
    return boot(':memory:');
  }

  test('EMPTY/fresh (no tag, unenrolled) → BINDS the current tag, no throw', async () => {
    const app = await migratedDb();
    await deleteMeta(app.db.db, DB_CIPHER_KEY_TAG_META_KEY); // undo the bind boot() already did
    expect(await readMeta(app.db.db, DB_CIPHER_KEY_TAG_META_KEY)).toBeNull();

    await assertDatabaseKeyBinding(app.db.db, app.db.columnCipherMarker, null);

    expect(await readMeta(app.db.db, DB_CIPHER_KEY_TAG_META_KEY)).toBe(app.db.columnCipherMarker);
    await app.close();
  });

  test('HEALTHY (tag matches) → returns, no throw, even for an enrolled device', async () => {
    const app = await migratedDb();
    await writeMeta(app.db.db, DB_CIPHER_KEY_TAG_META_KEY, app.db.columnCipherMarker);
    await expect(
      assertDatabaseKeyBinding(app.db.db, app.db.columnCipherMarker, 'device-x'),
    ).resolves.toBeUndefined();
    await app.close();
  });

  test('FOREIGN (tag present but different) → throws ForeignDatabaseError', async () => {
    const app = await migratedDb();
    await writeMeta(
      app.db.db,
      DB_CIPHER_KEY_TAG_META_KEY,
      `${String.fromCharCode(1)}gcm1:NOTOURSTAG00:`,
    );
    await expect(
      assertDatabaseKeyBinding(app.db.db, app.db.columnCipherMarker, null),
    ).rejects.toBeInstanceOf(ForeignDatabaseError);
    await app.close();
  });

  test('PARTIAL/interrupted first-run (no tag but deviceId set) → FOREIGN, refuses to adopt (defence in depth)', async () => {
    // An "enrolled" DB with no tag cannot arise on any same-device path (the tag is bound on first
    // boot, before enrolment). Adopting it would re-create the exact silent-half-enrolled bug, so the
    // probe treats it as foreign rather than binding our tag over someone else's ciphertext.
    const app = await migratedDb();
    await deleteMeta(app.db.db, DB_CIPHER_KEY_TAG_META_KEY);
    await expect(
      assertDatabaseKeyBinding(app.db.db, app.db.columnCipherMarker, 'device-x'),
    ).rejects.toBeInstanceOf(ForeignDatabaseError);
    // It did NOT bind — it refused, it did not adopt.
    expect(await readMeta(app.db.db, DB_CIPHER_KEY_TAG_META_KEY)).toBeNull();
    await app.close();
  });

  test('a probe READ failure surfaces RAW (never a foreign verdict) and binds nothing', async () => {
    // "Could not read right now" ≠ "cannot decrypt". A read that throws propagates unwrapped, so
    // recovery.ts surfaces it instead of wiping. Simulated by removing the table the probe reads.
    const app = await migratedDb();
    await app.db.driver.execute('DROP TABLE meta_kv');

    const err = await assertDatabaseKeyBinding(app.db.db, app.db.columnCipherMarker, null).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    expect(err).not.toBeInstanceOf(ForeignDatabaseError);
    expect(isUnrecoverableLocalDbError(err)).toBe(false); // → surfaces, not wiped
    await app.close();
  });
});

describe('isUnrecoverableLocalDbError classifies the probe verdict', () => {
  test('HEALS a ForeignDatabaseError (the live post-D22 trigger)', () => {
    expect(
      isUnrecoverableLocalDbError(new ForeignDatabaseError('sealed with a different key')),
    ).toBe(true);
  });

  test('SURFACES a transient DbError and a bare Error — only a definitive foreign verdict wipes', () => {
    expect(isUnrecoverableLocalDbError(new DbError('unknown', 'disk I/O error'))).toBe(false);
    expect(isUnrecoverableLocalDbError(new Error('a marker read blew up'))).toBe(false);
  });
});

/**
 * A driver whose `meta_kv` read FAILS only for the key-tag probe's query — its bound param is
 * `DB_CIPHER_KEY_TAG_META_KEY`, so migrations and the earlier `readDeviceId` (param `'deviceId'`) run
 * untouched and the failure lands exactly on the probe read.
 */
function failMarkerReadDriver(): (p: DbDriverOpenParams) => Promise<DbDriver> {
  return async (params) => {
    const real = await openBetterSqlite3Driver(params);
    return {
      ...real,
      execute(
        query: string,
        values?: readonly unknown[],
      ): Promise<ReturnType<DbDriver['execute']>> {
        if (values?.[0] === DB_CIPHER_KEY_TAG_META_KEY) {
          return Promise.reject(toDbError(new Error('disk I/O error'))) as never;
        }
        return real.execute(query, values as never);
      },
    } as DbDriver;
  };
}
