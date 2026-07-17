import { registerRootComponent } from 'expo';
import { Platform } from 'react-native';

import { openOpSqliteDriver } from '@bolusi/db-client/op-sqlite';

import { bootstrap, type Bootstrapped } from './src/bootstrap/bootstrap.js';
import { Root } from './src/bootstrap/Root.js';
import { createSyncClientForApp, type SyncClient } from './src/bootstrap/sync-client.js';
import { appStatePort } from './src/ports/app-state.js';
import { systemClock } from './src/ports/clock.js';
import { quickCryptoPort } from './src/ports/crypto.js';
import { SecureStoreDbKeyStore } from './src/ports/db-keystore.js';
import { SecureStoreKeyStore } from './src/ports/keystore.js';
import { fileLocaleStore } from './src/ports/locale-store.js';
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
  return bootstrap({
    driverFactory: openOpSqliteDriver,
    // The SQLCipher key store (security-guide §6.4). quick-crypto is the CSPRNG — §6.4 names it,
    // and D8 makes it the sole on-device provider.
    keyStore: new SecureStoreDbKeyStore(quickCryptoPort),
    crypto: quickCryptoPort,
    clock: systemClock,
  });
}

/**
 * THE OTHER NATIVE-BINDING SITE (task 89): NetInfo and RN `AppState` are native modules that cannot
 * load under Node, so — like op-sqlite above — they are imported HERE and injected downward through
 * `createSync`. `Root`/`sync-client` name only the `NetInfoPort` / `AppStatePort` interfaces, so the
 * whole sync client runs under fakes in CI.
 *
 * Returns `null` for an UNENROLLED device (`app.deviceId === null`): no loop is constructed for a
 * device that cannot sync. In production this is always the case today — no enrollment path persists a
 * `deviceId` (the genesis append awaits the command-runtime composition task) — so the loop stays
 * unstarted, honestly, until that lands. `EXPO_PUBLIC_API_URL` is the server base (08 §6.1); Expo
 * inlines `EXPO_PUBLIC_*` into the bundle at build. The `bdt_` device token is read PER CALL from
 * SecureStore (never cached), so a revoked device stops authenticating at once (api/02-auth §7.3).
 */
const API_BASE_URL = (process.env['EXPO_PUBLIC_API_URL'] ?? '').replace(/\/+$/, '');

function createSync(app: Bootstrapped): SyncClient | null {
  if (app.deviceId === null) return null;
  const keystore = new SecureStoreKeyStore();
  return createSyncClientForApp(app, {
    baseUrl: API_BASE_URL,
    deviceId: app.deviceId,
    loadDeviceToken: () => keystore.loadDeviceToken(),
    crypto: quickCryptoPort,
    clock: systemClock,
    appState: appStatePort,
    netInfo: netInfoPort,
  });
}

function Bootstrapped(): React.JSX.Element | null {
  return Root({
    boot,
    createSync,
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
