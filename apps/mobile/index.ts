import { registerRootComponent } from 'expo';
import { Platform } from 'react-native';

import { createUuidV7Generator } from '@bolusi/core';
import { DEFAULT_DATABASE_NAME } from '@bolusi/db-client';
import { deleteOpSqliteDatabase, openOpSqliteDriver } from '@bolusi/db-client/op-sqlite';

import { bootstrap, type Bootstrapped } from './src/bootstrap/bootstrap.js';
import { bootWithLocalRecovery } from './src/bootstrap/recovery.js';
import { requireApiBaseUrl } from './src/bootstrap/config.js';
import { createEnrollTransport, createLoginTransport } from './src/bootstrap/enroll-transport.js';
import {
  createAppEnrollment,
  type AppEnrollment,
  type EnrollmentPlatform,
} from './src/bootstrap/enrollment.js';
import { Root } from './src/bootstrap/Root.js';
import { createSyncClientForApp, type SyncClient } from './src/bootstrap/sync-client.js';
import { appStatePort } from './src/ports/app-state.js';
import { systemClock } from './src/ports/clock.js';
import { quickCryptoPort } from './src/ports/crypto.js';
import { SecureStoreDbKeyStore } from './src/ports/db-keystore.js';
import { SecureStoreKeyStore } from './src/ports/keystore.js';
import { fileLocaleStore } from './src/ports/locale-store.js';
import { expoLocationPort } from './src/ports/location.js';
import { netInfoPort } from './src/ports/netinfo.js';

/**
 * The registered root.
 *
 * `Root` (src/bootstrap/Root.tsx) is the composition root; its header states exactly what is real,
 * what is a seam, and what is not built yet — read it before wiring task 15. `App` is deliberately
 * NOT registered directly any more: it takes every input as a prop so it stays drivable from fakes,
 * which means something has to supply them, and that something is `Root`.
 *
 * DEVICE INFO IS EMPTY UNTIL ENROLLMENT, and that is honest rather than lazy. Every field except
 * `platform` is a fact the SERVER establishes: `api/02-auth` §4.3's enroll response carries the
 * deviceId, tenant and store, and §4.1 step 5 persists them. Reading a device name out of
 * `expo-constants` would put a plausible-looking value on the Settings screen that has nothing to do
 * with the device row an owner is about to revoke — and `expo-constants` is not pinned in 08 §2.2, so
 * adding it is a spec-table change requiring a stop-and-ask (CLAUDE.md §4/§6) for no gain. The
 * bootstrap (task 24 item 2) hands the persisted values in.
 */
/**
 * THE ONE op-sqlite BINDING SITE in the app (08 §3.2; testing-guide §2.3).
 *
 * `@bolusi/db-client/op-sqlite` is a JSI native module that cannot load under Node, which is why it
 * is imported HERE — the one file no Node test imports — and injected downward. Everything below
 * (`bootstrap`, `Root`) names only `DbDriverFactory`, so the whole data layer runs against
 * better-sqlite3 in CI and against SQLCipher on device, through identical code.
 *
 * The op-sqlite CONFIG (`sqlcipher: true`, `performanceMode: true`) is not here and cannot be: 08
 * §2.2 says it goes in `package.json`'s `op-sqlite` block, read at native build time. It is there.
 */
function boot(): Promise<Awaited<ReturnType<typeof bootstrap>>> {
  // ONE key store serves BOTH the boot (mint/read the SQLCipher key — security-guide §6.4; quick-
  // crypto is the CSPRNG, §6.4/D8) AND the recovery wipe (crypto-erase that key).
  const keyStore = new SecureStoreDbKeyStore(quickCryptoPort);
  // `bootWithLocalRecovery` self-heals the one boot failure that is NOT a corrupt data layer but a
  // FRESH device wearing an old device's ciphertext: an iOS restore-to-new-hardware restores
  // `bolusi.db` but not its THIS_DEVICE_ONLY key, so the open fails `not_a_database` and — before
  // this — Root's deliberate no-catch rendered nothing forever (security-guide §6.6). On that class
  // ONLY it wipes and drops to enrollment; every other failure still surfaces through Root's no-catch.
  return bootWithLocalRecovery({
    boot: () =>
      bootstrap({
        driverFactory: openOpSqliteDriver,
        keyStore,
        crypto: quickCryptoPort,
        clock: systemClock,
      }),
    // The api/02-auth §7.3 wipe legs this recovery owns, IN ORDER: (1) crypto-erase the SQLCipher key
    // FIRST (the DB is unreadable ciphertext from this moment), then (2) delete the DB file(s) +
    // WAL/SHM. On new hardware the identity keys (private key, token) are already absent
    // (THIS_DEVICE_ONLY, never restored), and a fresh empty DB reads `deviceId: null` → the
    // enrollment wizard, so this destroys exactly what makes the re-open clean. It NEVER opens the DB
    // unencrypted (SEC-DEV-06). Native, and unverifiable on this infra (no iOS/Android target,
    // D12/D13) — the heal LOGIC is unit-verified against the `DbOpenError` kinds (recovery.test.ts).
    wipeLocalData: async () => {
      await keyStore.wipe();
      deleteOpSqliteDatabase({ name: DEFAULT_DATABASE_NAME });
    },
  });
}

/**
 * THE OTHER NATIVE-BINDING SITE (task 89): NetInfo and RN `AppState` are native modules that cannot
 * load under Node, so — like op-sqlite above — they are imported HERE and injected downward through
 * `createSync`. `Root`/`sync-client` name only the `NetInfoPort` / `AppStatePort` interfaces, so the
 * whole sync client runs under fakes in CI.
 *
 * Returns `null` for an UNENROLLED device (`app.deviceId === null`): no loop is constructed for a
 * device that cannot sync. Since task 92 the enrollment path is REAL — `createEnrollment` (below)
 * appends the genesis and persists `deviceId`, and Root starts this loop on enroll success — so a FRESH
 * device returns `null` here only until the wizard runs, not forever. `EXPO_PUBLIC_API_URL` is the
 * server base (08 §6.1); Expo inlines `EXPO_PUBLIC_*` into the bundle at build. The `bdt_` device token
 * is read PER CALL from SecureStore (never cached), so a revoked device stops authenticating at once
 * (api/02-auth §7.3).
 */
// `EXPO_PUBLIC_API_URL` is read HERE (the native-binding site) so Expo inlines it at build; the guard
// itself lives in bootstrap/config.ts, pure and unit-tested. `?? ''` used to sit on this read — the
// T-19 bug the carry-in flagged. Now an unset URL fails loud (see requireApiBaseUrl).
function apiBaseUrl(): string {
  return requireApiBaseUrl(process.env['EXPO_PUBLIC_API_URL']);
}

function createSync(
  app: Bootstrapped,
  onBundleRefreshed?: () => void | Promise<void>,
): SyncClient | null {
  if (app.deviceId === null) return null;
  const keystore = new SecureStoreKeyStore();
  return createSyncClientForApp(app, {
    baseUrl: apiBaseUrl(),
    deviceId: app.deviceId,
    loadDeviceToken: () => keystore.loadDeviceToken(),
    crypto: quickCryptoPort,
    clock: systemClock,
    appState: appStatePort,
    netInfo: netInfoPort,
    ...(onBundleRefreshed === undefined ? {} : { onBundleRefreshed }),
  });
}

/**
 * Wire the enrollment caller over a booted app (api/02-auth §4) — THE native binding for enrollment.
 *
 * ONE `SecureStoreKeyStore` serves as both the enroll keystore (persists the device seed) AND the
 * command runtime's signing key, so the seed `runEnrollment` caches on generation is exactly what the
 * genesis op is signed with. quick-crypto is the CSPRNG + Ed25519 (D8); the UUIDv7 id source is bound
 * over the clock + that CSPRNG; expo-location feeds the envelope. The genesis runs through the composed
 * command runtime + the production op store (bootstrap/runtime.ts). Requires the server URL, so an
 * unset `EXPO_PUBLIC_API_URL` fails loud at boot rather than later, mid-enrollment.
 */
function createEnrollment(
  app: Bootstrapped,
  onEnrolled: (deviceId: string) => void,
): AppEnrollment {
  const baseUrl = apiBaseUrl();
  const keystore = new SecureStoreKeyStore();
  const platform: EnrollmentPlatform = {
    loginTransport: createLoginTransport({ baseUrl }),
    enrollTransport: createEnrollTransport({ baseUrl }),
    keystore,
    crypto: quickCryptoPort,
    clock: systemClock,
    idSource: createUuidV7Generator({
      now: () => systemClock.now(),
      randomBytes: (n) => quickCryptoPort.randomBytes(n),
    }),
    location: expoLocationPort,
    // No loop runs during enrollment; the genesis is durable on commit and the loop's boot sync (Root
    // starts it on success) pushes it. Task 25's command runtime binds the real append trigger.
    syncScheduler: { schedule: () => undefined },
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    // appVersion is left empty: expo-constants is not pinned (08 §2.2), and adding it is a spec-table
    // change (§4/§6). Empty is valid per the server's EnrollReq (`z.string().max(32)`) — filed as a
    // follow-up rather than faked with a plausible-but-wrong version (T-19).
    appVersion: '',
  };
  return createAppEnrollment(app, platform, onEnrolled);
}

function Bootstrapped(): React.JSX.Element | null {
  return Root({
    boot,
    createSync,
    createEnrollment,
    localeStore: fileLocaleStore,
    deviceInfo: {
      deviceId: '',
      deviceName: '',
      storeName: '',
      tenantName: '',
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      appVersion: '',
    },
  });
}

registerRootComponent(Bootstrapped);
