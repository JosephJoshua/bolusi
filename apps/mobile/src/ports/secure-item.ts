// One SecureStore item with the storage policy every device credential shares.
//
// iOS ACCESSIBILITY: AFTER FIRST UNLOCK, THIS DEVICE ONLY (Joseph, 2026-10-26). Background sync and
// media upload run while the phone is locked. A `WHEN_UNLOCKED` item is unreadable then: the read
// throws (errSecInteractionNotAllowed), so a locked iPhone could neither open its database nor sign
// a push. After first unlock keeps the items readable until the next reboot, and THIS_DEVICE_ONLY
// still keeps them out of backups and restores (api/02-auth §7.4, see ports/keystore.ts).
// Android ignores `keychainAccessible` (see ports/keystore.ts), so nothing changes there.
//
// MOVING EXISTING iOS ITEMS. An iOS item keeps the accessibility it was added with:
// expo-secure-store's set on an existing item only updates the value (errSecDuplicateItem →
// SecItemUpdate of kSecValueData). So the new items live under their own keychain service, and an
// item an older build wrote (default service, `WHEN_UNLOCKED`) is copied forward on its first read
// while the phone is unlocked. The copy is written before the old item is deleted, so a crash at any
// point leaves at least one readable copy of the same value. The value never changes: losing or
// replacing the database key orphans the database for good (ports/db-keystore.ts).
//
// A locked read of an old item throws instead of returning null, and that throw must reach the
// caller: a null would make `ensureDatabaseEncryptionKey` mint a fresh key over the real one.
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

export interface SecureItem {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  delete(): Promise<void>;
}

/** The keychain service that holds the after-first-unlock items on iOS. */
export const IOS_KEYCHAIN_SERVICE = 'bolusi';

const ACCESSIBLE = SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY;

// Operations on one item run one at a time, across every instance in the process. Otherwise a read
// that is copying an old value forward could land after a concurrent `set` and put the old value back.
const queues = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(task, task);
  queues.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

export function secureItem(key: string, os: string = Platform.OS): SecureItem {
  if (os !== 'ios') {
    const options: SecureStore.SecureStoreOptions = { keychainAccessible: ACCESSIBLE };
    return {
      get: () => serialized(key, () => SecureStore.getItemAsync(key, options)),
      set: (value) => serialized(key, () => SecureStore.setItemAsync(key, value, options)),
      delete: () => serialized(key, () => SecureStore.deleteItemAsync(key, options)),
    };
  }

  const current: SecureStore.SecureStoreOptions = {
    keychainService: IOS_KEYCHAIN_SERVICE,
    keychainAccessible: ACCESSIBLE,
  };
  const legacy: SecureStore.SecureStoreOptions = {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  };

  return {
    get: () =>
      serialized(key, async () => {
        const value = await SecureStore.getItemAsync(key, current);
        if (value !== null) return value;
        const old = await SecureStore.getItemAsync(key, legacy);
        if (old === null) return null;
        try {
          await SecureStore.setItemAsync(key, old, current);
          await SecureStore.deleteItemAsync(key, legacy);
        } catch {
          // The old item still holds the value; the next unlocked read tries the move again.
        }
        return old;
      }),
    set: (value) =>
      serialized(key, async () => {
        await SecureStore.setItemAsync(key, value, current);
        await SecureStore.deleteItemAsync(key, legacy);
      }),
    delete: () =>
      serialized(key, async () => {
        // Old copy first: a wipe cut short must not leave an item that a later read copies forward.
        await SecureStore.deleteItemAsync(key, legacy);
        await SecureStore.deleteItemAsync(key, current);
      }),
  };
}
