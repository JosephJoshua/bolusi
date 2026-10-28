// `secureItem` — the shared SecureStore policy and the move of existing iOS items to after first unlock.
//
// The fake keychain stores items by keychain service and key, like the iOS module: the default
// service is "app", and a set on an existing item keeps its accessibility and changes only the value.
// A locked read of a WHEN_UNLOCKED item throws, as SecItemCopyMatching does. What this cannot show
// is the real Keychain's behaviour on a locked iPhone; that needs a device.
import { beforeEach, describe, expect, test, vi } from 'vitest';

interface Stored {
  value: string;
  accessible: string | undefined;
}

const keychain = new Map<string, Stored>();
const state = { locked: false, failNextSet: false };

function slot(key: string, options: { keychainService?: string } | undefined): string {
  return `${options?.keychainService ?? 'app'}/${key}`;
}

vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  getItemAsync: vi.fn(
    async (key: string, options?: { keychainService?: string }): Promise<string | null> => {
      const item = keychain.get(slot(key, options));
      if (item === undefined) return null;
      if (state.locked && item.accessible === 'WHEN_UNLOCKED_THIS_DEVICE_ONLY') {
        throw new Error('errSecInteractionNotAllowed');
      }
      return item.value;
    },
  ),
  setItemAsync: vi.fn(
    async (
      key: string,
      value: string,
      options?: { keychainService?: string; keychainAccessible?: string },
    ): Promise<void> => {
      if (state.failNextSet) {
        state.failNextSet = false;
        throw new Error('errSecIO');
      }
      const existing = keychain.get(slot(key, options));
      keychain.set(slot(key, options), {
        value,
        accessible: existing?.accessible ?? options?.keychainAccessible,
      });
    },
  ),
  deleteItemAsync: vi.fn(async (key: string, options?: { keychainService?: string }) => {
    keychain.delete(slot(key, options));
  }),
}));

import * as SecureStore from 'expo-secure-store';

import { IOS_KEYCHAIN_SERVICE, secureItem } from './secure-item';

const KEY = 'bolusi.db_encryption_key';
const OLD = `app/${KEY}`;
const NEW = `${IOS_KEYCHAIN_SERVICE}/${KEY}`;

function writtenByOlderBuild(value: string): void {
  keychain.set(OLD, { value, accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' });
}

beforeEach(() => {
  vi.clearAllMocks();
  keychain.clear();
  state.locked = false;
  state.failNextSet = false;
});

describe('Android', () => {
  test('keeps the existing items and passes after first unlock, which Android ignores', async () => {
    keychain.set(OLD, { value: 'k1', accessible: undefined });
    const item = secureItem(KEY, 'android');

    expect(await item.get()).toBe('k1');
    await item.set('k2');
    await item.delete();

    const expected = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
    expect(vi.mocked(SecureStore.getItemAsync)).toHaveBeenCalledWith(KEY, expected);
    expect(vi.mocked(SecureStore.setItemAsync)).toHaveBeenCalledWith(KEY, 'k2', expected);
    expect(vi.mocked(SecureStore.deleteItemAsync)).toHaveBeenCalledWith(KEY, expected);
    expect(keychain.size).toBe(0);
  });
});

describe('iOS', () => {
  test('a new item is written after first unlock under the bolusi service', async () => {
    await secureItem(KEY, 'ios').set('k1');

    expect(keychain.get(NEW)).toStrictEqual({
      value: 'k1',
      accessible: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
    });
    expect(keychain.has(OLD)).toBe(false);
  });

  test("an older build's item moves on the first unlocked read with the same value", async () => {
    writtenByOlderBuild('k1');

    expect(await secureItem(KEY, 'ios').get()).toBe('k1');

    expect(keychain.get(NEW)).toStrictEqual({
      value: 'k1',
      accessible: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
    });
    expect(keychain.has(OLD)).toBe(false);
  });

  test('once moved, the item is readable while the phone is locked', async () => {
    writtenByOlderBuild('k1');
    await secureItem(KEY, 'ios').get();

    state.locked = true;

    expect(await secureItem(KEY, 'ios').get()).toBe('k1');
  });

  test('a locked read of an unmoved item throws rather than reading as missing', async () => {
    // A null here would let ensureDatabaseEncryptionKey mint a new key over the real one.
    writtenByOlderBuild('k1');
    state.locked = true;

    await expect(secureItem(KEY, 'ios').get()).rejects.toThrow('errSecInteractionNotAllowed');
    expect(keychain.get(OLD)?.value).toBe('k1');
    expect(keychain.has(NEW)).toBe(false);
  });

  test('a failed copy still returns the value, keeps the old item, and retries next read', async () => {
    writtenByOlderBuild('k1');
    state.failNextSet = true;

    expect(await secureItem(KEY, 'ios').get()).toBe('k1');
    expect(keychain.get(OLD)?.value).toBe('k1');

    expect(await secureItem(KEY, 'ios').get()).toBe('k1');
    expect(keychain.get(NEW)?.value).toBe('k1');
    expect(keychain.has(OLD)).toBe(false);
  });

  test('a set racing a read that is moving an old value is not undone by it', async () => {
    writtenByOlderBuild('old');
    const item = secureItem(KEY, 'ios');

    const read = item.get();
    const write = item.set('new');
    await Promise.all([read, write]);

    expect(await read).toBe('old');
    expect(keychain.get(NEW)?.value).toBe('new');
    expect(keychain.has(OLD)).toBe(false);
  });

  test('delete removes both copies, the old one first', async () => {
    writtenByOlderBuild('k1');
    keychain.set(NEW, { value: 'k1', accessible: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY' });

    await secureItem(KEY, 'ios').delete();

    expect(keychain.size).toBe(0);
    expect(vi.mocked(SecureStore.deleteItemAsync).mock.calls.map((c) => c[1])).toStrictEqual([
      { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
      {
        keychainService: IOS_KEYCHAIN_SERVICE,
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      },
    ]);
    expect(await secureItem(KEY, 'ios').get()).toBeNull();
  });
});
