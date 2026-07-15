// `SecureStoreKeyStore` — the two-credential device keystore (api/02-auth §3, §7.3).
//
// This suite exists because review-05 asked of `keystore.ts:34` "if this line silently changed, what
// would notice?" and the answer was **nothing**: same enum → `tsc` green, no lint rule, no test, and
// a file whose careful comments read as diligence. `vi.mock('expo-secure-store')` is enough for all
// of it — no device needed — which is the point: the hole was never a hard one to close.
//
// WHAT THIS SUITE CANNOT ANSWER: whether SecureStore actually persists, encrypts, or survives a
// restore on real hardware. It asserts THIS module's contract with SecureStore — the arguments it
// passes and the state it keeps — not SecureStore's behaviour. The at-rest and restore legs are
// unverifiable here (D12/D13: no physical Android).
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({
  // Mirrors the real module's shape. The constants are re-exported values, not behaviour.
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  setItemAsync: vi.fn(async () => undefined),
  getItemAsync: vi.fn(async () => null),
  deleteItemAsync: vi.fn(async () => undefined),
}));

import * as SecureStore from 'expo-secure-store';

import { SecureStoreKeyStore } from './keystore';

const setItemAsync = vi.mocked(SecureStore.setItemAsync);
const getItemAsync = vi.mocked(SecureStore.getItemAsync);
const deleteItemAsync = vi.mocked(SecureStore.deleteItemAsync);

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i);
/** The base64 of SEED — what must reach SecureStore for `bolusi.device_private_key`. */
const SEED_B64 = Buffer.from(SEED).toString('base64');

beforeEach(() => {
  vi.clearAllMocks();
  getItemAsync.mockResolvedValue(null);
});

describe('the options object reaching SecureStore', () => {
  // THE POINT OF THIS BLOCK (task 58): `keychainAccessible` is an **iOS-only** option — Expo's
  // SecureStoreOptions docs say "Supported platforms: iOS", and Android drops it on the floor. It is
  // still correct and load-bearing on iOS, a listed platform, so it must keep reaching SecureStore
  // unchanged. Nothing else in the repo would notice if it silently changed: the constant is
  // exported for every platform, so a wrong-but-well-typed value keeps `tsc` green.
  test('persistDevicePrivateKey passes WHEN_UNLOCKED_THIS_DEVICE_ONLY', async () => {
    await new SecureStoreKeyStore().persistDevicePrivateKey(SEED);

    expect(setItemAsync).toHaveBeenCalledWith('bolusi.device_private_key', SEED_B64, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  });

  test('every read and write of both credentials carries the same options', async () => {
    const store = new SecureStoreKeyStore();
    await store.persistDeviceToken('bdt_token');
    await store.loadDeviceToken();
    await store.loadSigningKey();
    await store.wipe();

    const expected = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
    for (const call of [
      ...setItemAsync.mock.calls,
      ...getItemAsync.mock.calls,
      ...deleteItemAsync.mock.calls,
    ]) {
      expect(call.at(-1)).toStrictEqual(expected);
    }
  });
});

describe('wipe (api/02-auth §7.3 — crypto-erase)', () => {
  test("deletes both of this surface's credentials", async () => {
    await new SecureStoreKeyStore().wipe();

    expect(deleteItemAsync.mock.calls.map((c) => c[0])).toStrictEqual([
      'bolusi.device_private_key',
      'bolusi.device_token',
    ]);
  });

  test('clears the in-memory signing key — a cached seed surviving a wipe defeats the erase', async () => {
    const store = new SecureStoreKeyStore();
    await store.persistDevicePrivateKey(SEED);
    expect(store.getSigningKey()).toStrictEqual(SEED); // cached, so the wipe has something to clear

    await store.wipe();

    // The seed is the crown jewel (PRD-011 §8). Deleting it from SecureStore while the process kept
    // a copy in `#signingKey` would leave the runtime able to sign for a revoked device until the
    // app happened to restart — the exact thing §7.3's crypto-erase exists to prevent.
    expect(() => store.getSigningKey()).toThrow(/not loaded/);
  });

  test("does not delete the SQLCipher key — that is task 15/§6.4's, and it must go FIRST", async () => {
    await new SecureStoreKeyStore().wipe();

    // Ordering is the revocation handler's to own (§7.3 step 1 deletes db_encryption_key first,
    // because that is what makes the DB unreadable ciphertext if later steps are interrupted). If
    // this port ever deleted it, it would be racing the handler for the ordering guarantee.
    expect(deleteItemAsync.mock.calls.map((c) => c[0])).not.toContain('bolusi.db_encryption_key');
  });
});

describe('getSigningKey', () => {
  test('throws when unloaded rather than handing empty bytes to the signer', () => {
    // Returning an empty/zero key here would produce ops signed with a garbage key: they would be
    // rejected server-side as BAD_SIGNATURE and land in `device_anomalies` (security-guide §6.2),
    // i.e. an unenrolled device would look like a forger. Throwing is the contract.
    expect(() => new SecureStoreKeyStore().getSigningKey()).toThrow(/not loaded/);
  });

  test('is synchronous and returns the seed once loaded from SecureStore', async () => {
    getItemAsync.mockResolvedValue(SEED_B64);
    const store = new SecureStoreKeyStore();

    expect(await store.loadSigningKey()).toStrictEqual(SEED);
    expect(store.getSigningKey()).toStrictEqual(SEED); // sync: op signing cannot await (04 §5.1)
  });

  test('loadSigningKey returns null for an unenrolled device and leaves getSigningKey throwing', async () => {
    // This is the restore-to-new-hardware path on Android. expo-secure-store's own Android source
    // returns null (not throws) when the SharedPreferences entry outlives its Keystore key — it logs
    // "there is no corresponding KeyStore key … Returning null" and deletes the entry. So a restored
    // phone reads as unenrolled and re-enrolls with a fresh keypair, which is api/02-auth §7.4's
    // required outcome. Verified from source, not assumed; asserted here so a future change that
    // made this path throw would fail rather than brick bootstrap on a restored device.
    getItemAsync.mockResolvedValue(null);
    const store = new SecureStoreKeyStore();

    expect(await store.loadSigningKey()).toBeNull();
    expect(() => store.getSigningKey()).toThrow(/not loaded/);
  });
});

describe('the 2 KB item limit (api/02-auth §3: "each value < 2 KB")', () => {
  test('accepts a value exactly at the limit and rejects one byte past it', async () => {
    const store = new SecureStoreKeyStore();

    await expect(store.persistDeviceToken('a'.repeat(2048))).resolves.toBeUndefined();
    await expect(store.persistDeviceToken('a'.repeat(2049))).rejects.toThrow(
      /must stay under 2048/,
    );
  });

  test('rejects an oversized seed BEFORE it reaches SecureStore', async () => {
    // The guard is only worth having if it fires first: SecureStore's own failure for an oversized
    // item is the silent kind, which is exactly when this would matter.
    const store = new SecureStoreKeyStore();
    // 1537 bytes → 2052 base64 chars, the first seed size that crosses the limit.
    await expect(store.persistDevicePrivateKey(new Uint8Array(1537))).rejects.toThrow(
      /device_private_key is 2052 bytes/,
    );
    expect(setItemAsync).not.toHaveBeenCalled();
  });
});
