// THE BOOTSTRAP (task 50) — `bootstrap()`: SQLCipher key → open → migrate → register → sync state.
//
// Every test here drives the REAL `bootstrap()` over the REAL `CLIENT_MODULES` and the REAL
// `CLIENT_MIGRATIONS`. None builds its own registry, none hand-creates a table, and none asserts
// against a fake handle. That is the whole design of this file, and the reason is task 24's:
//
//   "A fake `open()` returning a working-looking handle is precisely the green-for-the-wrong-reason
//    shape."
//
// A suite that opened its own database and ran migrations itself would be GREEN with `bootstrap()`
// deleted — which is exactly the state this file exists to detect.
//
// THE REPRODUCTION (T-11), captured as this file's first block: before task 50, `apps/mobile`
// contained ZERO references to `openClientDb` / `runClientMigrations` / `registerModules`, did not
// depend on `@bolusi/db-client` at all, and `Root.tsx` hand-built a `SyncStatusInput` literal. A
// write could not be made, let alone survive a restart, because no connection existed. The
// `survives a process restart` test below is that reproduction turned into a standing guard: it
// writes through the booted DB, closes, re-boots, and reads the row back.
//
// WHAT THIS LANE CANNOT ANSWER — do not read a green here as more than it is:
//   - SQLCipher. better-sqlite3 has no SQLCipher build and IGNORES `encryptionKey`, so this file
//     proves the key is demanded, read once, and passed through verbatim — never that the file on
//     disk is ciphertext. That is SEC-DEV-06's on-device leg (task 27a), unverifiable here (D12/D13:
//     no physical Android or iOS device).
//   - op-sqlite's actual one-connection behaviour. What is proven here is that `openClientDb`'s
//     guard REFUSES a second connection, which is the enforcement we control.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeClientDb, DbOpenError, isClientDbOpen } from '@bolusi/db-client';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  setItemAsync: vi.fn(async () => undefined),
  getItemAsync: vi.fn(async () => null),
  deleteItemAsync: vi.fn(async () => undefined),
}));

import * as SecureStore from 'expo-secure-store';

import { bootstrap } from '../src/bootstrap/bootstrap.js';
import { CLIENT_MODULES } from '../src/bootstrap/modules.js';
import { SecureStoreDbKeyStore } from '../src/ports/db-keystore.js';
import { openBetterSqlite3Driver, openedWith, resetOpenedWith } from './better-sqlite3-driver.js';

/**
 * A CSPRNG stand-in: deterministic across a run (T-6) but DIFFERENT ON EVERY CALL.
 *
 * The second half is load-bearing and was found by falsifying this file's own oracle (T-13). The
 * first version returned the same bytes every call, which made "the key is the same across two
 * boots" true even when the key was REGENERATED on the second boot — the assertion would have been
 * green for the wrong reason, and the generate-once test would have rested entirely on a
 * `setItemAsync` call count. A real CSPRNG never repeats, so the fake must not either: `nonce`
 * makes every generated key distinct, and the equality assertion becomes a real one.
 */
let nonce = 0;
const fakeCrypto = {
  randomBytes: (length: number) => {
    nonce += 1;
    return Uint8Array.from({ length }, (_, i) => (i * 7 + nonce * 31 + 3) & 0xff);
  },
} as unknown as Parameters<typeof bootstrap>[0]['crypto'];

const FIXED_NOW = 1_700_000_000_000;
const clock = { now: () => FIXED_NOW };

let tempDir: string;
/** A SecureStore stand-in with real read-your-writes — the generate-once tests need real state. */
let secureStore: Map<string, string>;

beforeEach(async () => {
  await closeClientDb(); // no connection leaks across tests — the one-connection rule is global
  resetOpenedWith();
  tempDir = mkdtempSync(join(tmpdir(), 'bolusi-bootstrap-'));
  secureStore = new Map<string, string>();
  // Call counts are assertions here ("written exactly once"), so they must not accumulate across
  // tests. `clearAllMocks` clears calls but keeps implementations — which are re-set below anyway.
  vi.clearAllMocks();
  vi.mocked(SecureStore.getItemAsync).mockImplementation(
    async (key: string) => secureStore.get(key) ?? null,
  );
  vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key: string, value: string) => {
    secureStore.set(key, value);
  });
  vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key: string) => {
    secureStore.delete(key);
  });
});

afterEach(async () => {
  await closeClientDb();
  rmSync(tempDir, { recursive: true, force: true });
});

function boot(location?: string) {
  return bootstrap({
    driverFactory: openBetterSqlite3Driver,
    keyStore: new SecureStoreDbKeyStore(fakeCrypto),
    crypto: fakeCrypto,
    clock,
    databaseLocation: location ?? ':memory:',
  });
}

describe('the DB opens, migrates, and PERSISTS — the reproduction, standing', () => {
  test('a cold boot opens the one connection and migrates it', async () => {
    expect(isClientDbOpen()).toBe(false); // nothing is open before the bootstrap runs

    const app = await boot();

    expect(isClientDbOpen()).toBe(true);
    // DENOMINATOR (T-14): assert the COUNT, not just "no throw". `runClientMigrations` over an
    // empty migration list returns `applied: []` and reports success having created no schema —
    // the loop-over-an-empty-registry failure this repo has shipped eight times.
    expect(app.migrationsApplied).toStrictEqual([1]);
    expect(app.migrationsApplied).toHaveLength(1);
    await app.close();
  });

  test('the migrations table records exactly what ran', async () => {
    const app = await boot();

    const rows = await sql<{ version: number; name: string }>`
      SELECT version, name FROM migrations ORDER BY version
    `.execute(app.db.db);

    // Read the bookkeeping the runner wrote, not the value it returned: a runner that returned
    // `[1]` while inserting nothing would pass the test above and fail this one.
    expect(rows.rows.map((r) => Number(r.version))).toStrictEqual([1]);
    await app.close();
  });

  test('a write SURVIVES A PROCESS RESTART — the thing that was impossible before task 50', async () => {
    // THE REPRODUCTION. Before this task there was no connection to write through: `apps/mobile` had
    // no db-client dependency and Root.tsx opened nothing. Boot → write → close → re-boot → read.
    // A file-backed location is load-bearing: `:memory:` dies with the connection, so this test
    // would pass against a database that never persisted anything (T-14b).
    const location = join(tempDir, 'restart.db');

    const first = await boot(location);
    await sql`INSERT INTO meta_kv (key, value) VALUES ('probe', 'written-before-restart')`.execute(
      first.db.db,
    );
    await first.close();
    expect(isClientDbOpen()).toBe(false);

    const second = await boot(location);
    const rows = await sql<{ value: string }>`
      SELECT value FROM meta_kv WHERE key = 'probe'
    `.execute(second.db.db);

    expect(rows.rows[0]?.value).toBe('written-before-restart');
    // The runner is idempotent: the second boot re-applies nothing. An `applied: [1]` here would
    // mean the migration ran twice — i.e. the bookkeeping is not being read.
    expect(second.migrationsApplied).toStrictEqual([]);
    await second.close();
  });
});

describe('EXACTLY ONE connection per DB, app-wide (08 §2.2 — a data-corruption constraint)', () => {
  test('a second bootstrap cannot open a second connection', async () => {
    const app = await boot();

    // Not a style preference: op-sqlite's rule is one handle per database, app-wide, and
    // concurrency comes from WAL. A second handle is corruption. The guard is `openClientDb`'s.
    await expect(boot()).rejects.toThrow(DbOpenError);
    await expect(boot()).rejects.toMatchObject({ code: 'already_open' });

    await app.close();
  });

  test('the failed second boot leaves the FIRST connection intact', async () => {
    // The negative control that makes the test above mean something (T-14b): a guard that refused
    // the second connection by tearing down the first would also make `rejects.toThrow` pass, and
    // would be a worse bug than the one it prevents.
    const app = await boot();
    await expect(boot()).rejects.toMatchObject({ code: 'already_open' });

    expect(isClientDbOpen()).toBe(true);
    const rows = await sql<{ c: number }>`SELECT COUNT(*) AS c FROM migrations`.execute(app.db.db);
    expect(Number(rows.rows[0]?.c)).toBe(1);
    await app.close();
  });

  test('closing releases the slot, so a later boot succeeds', async () => {
    // The other half of the same control: if `already_open` were permanent, the guard would brick
    // the app instead of protecting it.
    const app = await boot();
    await app.close();

    const again = await boot();
    expect(isClientDbOpen()).toBe(true);
    await again.close();
  });
});

describe('the SQLCipher key (security-guide §6.4) — a §2.5 security surface', () => {
  test('the key reaching the driver is the one SecureStore holds, and it is 32 bytes of hex', async () => {
    const app = await boot();

    expect(openedWith).toHaveLength(1);
    const key = openedWith[0]?.encryptionKey;
    // §6.4: "Key = 32 CSPRNG bytes". Hex ⇒ 64 lowercase chars. Asserting the SHAPE and the SOURCE:
    // a key that was 16 bytes, or that came from somewhere other than the store, passes neither.
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).toBe(secureStore.get('bolusi.db_encryption_key'));
    await app.close();
  });

  test('the key is generated ONCE and never regenerated — a second key orphans the database', async () => {
    // The most expensive bug available on this surface. There is no escrow and no recovery path
    // (§6.4), so overwriting the key turns a shop's device into unreadable ciphertext. Two boots
    // must read one key.
    const location = join(tempDir, 'once.db');
    const first = await boot(location);
    const firstKey = secureStore.get('bolusi.db_encryption_key');
    await first.close();

    const second = await boot(location);
    await second.close();

    expect(secureStore.get('bolusi.db_encryption_key')).toBe(firstKey);
    expect(openedWith.map((p) => p.encryptionKey)).toStrictEqual([firstKey, firstKey]);
    // Written exactly once across two boots — the second boot READ, it did not mint.
    expect(vi.mocked(SecureStore.setItemAsync).mock.calls).toHaveLength(1);
  });

  test('the fake CSPRNG never repeats — the control that makes the test above mean something', async () => {
    // T-13, interrogate the oracle. If `randomBytes` returned constant bytes, "the key is unchanged
    // across two boots" would hold even when the second boot regenerated it, and the generate-once
    // test would be green for the wrong reason. This asserts the instrument, not the code.
    const store = new SecureStoreDbKeyStore(fakeCrypto);
    const first = await store.ensureDatabaseEncryptionKey();
    secureStore.clear(); // force a genuine second generation
    const second = await store.ensureDatabaseEncryptionKey();

    expect(first).not.toBe(second);
  });

  test('concurrent boots of a fresh device mint ONE key, not two (the race half of the same bug)', async () => {
    // Two callers each reading `null` and each generating is the orphaning bug arriving by race
    // rather than by edit: the second write wins after the first has already opened under its value.
    const store = new SecureStoreDbKeyStore(fakeCrypto);
    const [a, b] = await Promise.all([
      store.ensureDatabaseEncryptionKey(),
      store.ensureDatabaseEncryptionKey(),
    ]);

    expect(a).toBe(b);
    expect(vi.mocked(SecureStore.setItemAsync).mock.calls).toHaveLength(1);
  });

  test('concurrent boots on SEPARATE keystore instances still mint ONE key (production builds a fresh keystore per boot)', async () => {
    // The race that matters in production: `index.ts` constructs a NEW `SecureStoreDbKeyStore` on
    // every `boot()`, so a per-instance single-flight would let two boots each read null, each
    // generate, and the second overwrite the first — orphaning the DB permanently (review-50b).
    // The single-flight is module-scoped precisely so the guard outlives any one instance.
    const [a, b] = await Promise.all([
      new SecureStoreDbKeyStore(fakeCrypto).ensureDatabaseEncryptionKey(),
      new SecureStoreDbKeyStore(fakeCrypto).ensureDatabaseEncryptionKey(),
    ]);

    expect(a).toBe(b);
    expect(vi.mocked(SecureStore.setItemAsync).mock.calls).toHaveLength(1);
  });

  test('NO KEY ⇒ refuses to open — never a silent plaintext fallback (SEC-DEV-06)', async () => {
    // The adversarial case. A bootstrap that degraded to an unencrypted open would put a shop's
    // data in plaintext on disk and boot green while doing it.
    const keyStore = new SecureStoreDbKeyStore(fakeCrypto);
    // Defeat generate-once so the store genuinely has nothing to give.
    vi.spyOn(keyStore, 'ensureDatabaseEncryptionKey').mockResolvedValue('');
    vi.spyOn(keyStore, 'getDatabaseEncryptionKey').mockResolvedValue(null);

    await expect(
      bootstrap({
        driverFactory: openBetterSqlite3Driver,
        keyStore,
        crypto: fakeCrypto,
        clock,
        databaseLocation: ':memory:',
      }),
    ).rejects.toMatchObject({ code: 'missing_key' });

    // The driver was never called: there is no "open it unencrypted and see".
    expect(openedWith).toHaveLength(0);
    expect(isClientDbOpen()).toBe(false);
  });

  test('the key never reaches SecureStore under another surface’s name', async () => {
    // ports/keystore.ts owns `bolusi.device_private_key` + `bolusi.device_token` and explicitly not
    // this one. Asserting the key NAME keeps the two surfaces from silently merging.
    const app = await boot();
    expect([...secureStore.keys()]).toStrictEqual(['bolusi.db_encryption_key']);
    await app.close();
  });
});

describe('module registration (04 §1/§3/§4; 02 §3.2 "startup failure, not a warning")', () => {
  test('the REAL CLIENT_MODULES register, with a non-zero denominator', async () => {
    const app = await boot();

    // T-14, and the reason this test is written this way: `registerModules([])` SUCCEEDS and returns
    // a registry that folds nothing and answers `undefined` to every lookup. A bootstrap looping
    // over it reports green having registered nothing. So assert the COUNT.
    expect(CLIENT_MODULES).toHaveLength(2);
    expect(app.registry.modules.map((m) => m.id)).toStrictEqual(['platform', 'notes']);

    // Op types: the fold denominator. Zero here means the projection engine can apply nothing.
    expect(app.registry.operations.size).toBeGreaterThan(0);
    expect(app.registry.operations.types()).toContain('platform.user_locale_changed');
    // notes (task 25) is now registered — its op types fold on the client.
    expect(app.registry.operations.types()).toContain('notes.note_created');

    // Permissions: the authz denominator. An empty registry denies `unknown_permission` on every
    // call forever — a permanent outage wearing an authorization decision's clothes (02 §5.2).
    expect(app.registry.permissions.size).toBe(7);
    expect(app.registry.permissions.ids()).toStrictEqual([
      'notes.archive',
      'notes.create',
      'notes.edit',
      'notes.read',
      'platform.conflict_acknowledge',
      'platform.conflict_view',
      'platform.set_locale',
    ]);
    await app.close();
  });

  test('the projection engine folds through the SAME registry the bootstrap registered', async () => {
    const app = await boot();

    // The engine is built from `registry.projections`, so a type the registry knows is a type the
    // engine can fold. Asserting the join rather than the two halves: task 49's lesson is that
    // shipping an applier without registering it is a half-fix that looks done and folds nothing.
    const applier = app.registry.projections.applierForType('platform.user_locale_changed');
    expect(applier).toBeDefined();
    // notes (task 25) is registered too — its create applier folds through THIS registry.
    expect(app.registry.projections.applierForType('notes.note_created')).toBeDefined();
    // The negative control (T-14b): a registry that answered a function for EVERY string would
    // satisfy the lines above while proving nothing about registration.
    expect(app.registry.projections.applierForType('nonexistent.never_registered')).toBeUndefined();
    await app.close();
  });
});

describe('SyncState is READ FROM THE DATABASE, not asserted by a component', () => {
  test('a fresh device reads lastSuccessfulSyncAt = null — the true state, from the real column', async () => {
    const app = await boot();

    // The honest-by-construction gap, preserved. `null` here is not a convenient placeholder: it is
    // what the seeded 10-db §9.3 row actually contains on a device that has never synced, and 03 §8
    // maps it to `stale` so the shell shows the loud never-connected banner. The difference from
    // task 24's literal is invisible on screen and total in kind: this one keeps telling the truth
    // after the first sync lands.
    expect(app.syncState.lastSuccessfulSyncAt).toBeNull();
    expect(app.syncState.lastServerTime).toBeNull();
    expect(app.syncState.pushHalted).toBe(false);
    expect(app.syncState.syncDisabled).toBe(false);
    expect(app.syncState.cursor).toBe(0);
    await app.close();
  });

  test('a synced device reads the REAL timestamp back — the null is read, never defaulted', async () => {
    // The positive control, and the one that matters (T-14b): a test that only ever asserts `null`
    // passes against `lastSuccessfulSyncAt: null` hardcoded — which is precisely what Root.tsx did
    // before this task. This one fails against any hardcode.
    const location = join(tempDir, 'synced.db');
    const first = await boot(location);
    await sql`UPDATE sync_state SET last_successful_sync_at = 1699999999000 WHERE id = 1`.execute(
      first.db.db,
    );
    await first.close();

    const second = await boot(location);
    expect(second.syncState.lastSuccessfulSyncAt).toBe(1699999999000);
    await second.close();
  });
});

describe('deviceId is READ FROM meta_kv — the enrolled-device gate for the sync loop (task 88/89)', () => {
  test('a fresh device reads deviceId = null — unenrolled, so the loop is NOT constructed', async () => {
    // The true state of every device this code can produce today: no enrollment path persists a
    // deviceId (the genesis append needs the command-runtime composition that no task has built), so
    // `deviceId` is null and Root/index start no loop. Null is READ from the column, never defaulted.
    const app = await boot();
    expect(app.deviceId).toBeNull();
    await app.close();
  });

  test('a persisted deviceId is read back on the next boot — the gate the loop gates on is REAL', async () => {
    // Task 88 writes deviceId to meta_kv on enrollment; here we write it directly (production writes
    // it via runEnrollment, which awaits the command-runtime composition) and prove bootstrap reads
    // the real value. This is the §2.11 falsification target: the loop starts BECAUSE this is non-null.
    const location = join(tempDir, 'enrolled.db');
    const first = await boot(location);
    await sql`INSERT INTO meta_kv (key, value) VALUES ('deviceId', 'device-abc')`.execute(
      first.db.db,
    );
    await first.close();

    const second = await boot(location);
    expect(second.deviceId).toBe('device-abc');
    await second.close();
  });
});
