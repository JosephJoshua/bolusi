import { registerRootComponent } from 'expo';
import { Platform } from 'react-native';

import { createUuidV7Generator, type CommandIdentity } from '@bolusi/core';
import type { NotesRuntime } from '@bolusi/modules/notes/screens';
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
import { readDeviceInfo } from './src/bootstrap/device-info.js';
import { createSessionNotesRuntime, UNWIRED_NOTES_MEDIA } from './src/bootstrap/notes.js';
import { Root } from './src/bootstrap/Root.js';
import type { AppRuntime } from './src/bootstrap/runtime.js';
import { createAppSession, type AppSessionController } from './src/bootstrap/session.js';
import { createSyncClientForApp, type SyncClient } from './src/bootstrap/sync-client.js';
import type { MediaClient } from './src/media/client.js';
import { createMediaClientForApp } from './src/media/native.js';
import { createFetchMediaTransport } from './src/media/transport.js';
import { appStatePort } from './src/ports/app-state.js';
import { systemClock } from './src/ports/clock.js';
import { quickCryptoPort } from './src/ports/crypto.js';
import { consoleDiagnostics } from './src/ports/diagnostics.js';
import { SecureStoreDbKeyStore } from './src/ports/db-keystore.js';
import { SecureStoreKeyStore } from './src/ports/keystore.js';
import { fileLocaleStore } from './src/ports/locale-store.js';
import { expoLocationPort } from './src/ports/location.js';
import { netInfoPort } from './src/ports/netinfo.js';
import { systemTimer } from './src/ports/timer.js';

/**
 * The registered root.
 *
 * `Root` (src/bootstrap/Root.tsx) is the composition root; its header states exactly what is real,
 * what is a seam, and what is not built yet — read it before wiring task 15. `App` is deliberately
 * NOT registered directly any more: it takes every input as a prop so it stays drivable from fakes,
 * which means something has to supply them, and that something is `Root`.
 *
 * DEVICE INFO IS DERIVED FROM PERSISTED STATE (task 94), not a literal. Every field except
 * `platform`/`appVersion` is a fact the SERVER establishes: `api/02-auth` §4.3's enroll response
 * carries the deviceId, tenant and store; enrollment persists the ids to meta_kv (task 88) and the
 * NAMES alongside them (bootstrap/device-info.ts). So `readDeviceInfo` reads the real identity of an
 * enrolled device here, and returns the honest empty block for a device that has not enrolled yet —
 * never a plausible-looking placeholder that has nothing to do with the device row an owner is about
 * to revoke. `appVersion` stays `''`: `expo-constants` is not pinned in 08 §2.2, and pinning it is a
 * spec-table change that needs a stop-and-ask (CLAUDE.md §4/§6) — deferred, see
 * `decisions/2026-07-20-appversion-source.md`, and left empty rather than faked (T-19).
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
/**
 * The app version string reported to the server on enroll AND shown on the Settings device block —
 * ONE source, so the two never disagree. Empty in v0: `expo-constants` is not pinned in 08 §2.2 and
 * pinning it (to read `Constants.expoConfig?.version`) is a spec-table change needing a stop-and-ask
 * (CLAUDE.md §4/§6). Deferred in `decisions/2026-07-20-appversion-source.md`; `''` is VALID per the
 * server's `EnrollReq` (`z.string().max(32)`) and honest — a plausible-but-wrong version is the T-19
 * lie this abstains from.
 */
const APP_VERSION = '';

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
 * THE MEDIA PIPELINE (task 82) — 06-media-pipeline's mobile half, bound to its native modules.
 *
 * `src/media/native.ts` supplies expo-file-system, expo-image-manipulator, expo-background-task and
 * expo-task-manager; this function supplies the rest — the one DB connection, the fetch media
 * transport (api/03 §3), and the same clock/crypto/NetInfo/AppState/location ports the sync client
 * uses. Constructed HERE for the same reason `createSync` is: those are native modules that cannot
 * load under Node, and everything below them names only interfaces.
 *
 * `null` for an UNENROLLED device: api/03 §2 requires a device token on every media endpoint, so a
 * device that has not enrolled has nothing to upload with. Capture itself would still work — the
 * pipeline is offline-first — but the queue would have no drain, and starting a loop that can only
 * fail is the working-looking shape this repo refuses.
 *
 * The `bdt_` token is read PER CALL from SecureStore, never cached, so a revoked device stops
 * authenticating at once (api/02-auth §7.3) — the same rule the sync legs follow.
 */
function createMedia(app: Bootstrapped): MediaClient | null {
  if (app.deviceId === null) return null;
  const keystore = new SecureStoreKeyStore();
  return createMediaClientForApp({
    db: app.db,
    transport: createFetchMediaTransport({
      baseUrl: apiBaseUrl(),
      deviceToken: () => keystore.loadDeviceToken(),
    }),
    crypto: quickCryptoPort,
    clock: systemClock,
    timer: systemTimer,
    appState: appStatePort,
    netInfo: netInfoPort,
    newId: createUuidV7Generator({
      now: () => systemClock.now(),
      randomBytes: (n) => quickCryptoPort.randomBytes(n),
    }),
    location: expoLocationPort,
    // 06 §8: silent failure is unacceptable. The client buffers per-item surfacings for the
    // sync-status screen; THIS sink is only for the rejections that escape a trigger (a drain that
    // could not even read the queue). It routes through the app's ONE client diagnostics channel
    // (§2.8 — the same object the denial audit and i18n write to), never a bare `console`.
    onError: (error) =>
      consoleDiagnostics.warn('media drain trigger failed', {
        error: error instanceof Error ? error.message : String(error),
      }),
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
    // Same `APP_VERSION` the Settings block shows — empty in v0 (expo-constants unpinned, decision
    // deferred). Valid per the server's EnrollReq (`z.string().max(32)`); not faked (T-19).
    appVersion: APP_VERSION,
  };
  return createAppEnrollment(app, platform, onEnrolled);
}

/**
 * THE SESSION CONTROLLER (task 119) — what turns a PIN keypress into an open session.
 *
 * Bound here, alongside the other composition factories, because it needs quick-crypto (the KDF
 * `verifyPin` runs) and the UUIDv7 source (the session id). It takes the SAME `AppRuntime` the
 * enrollment caller built, so session ops ride the one op store and one enforcement point.
 *
 * `null` for an unenrolled device (`createAppSession` reads the identity and answers null): there is
 * nobody to sign in as before enrollment, and the gate routes such a device to the wizard anyway.
 */
function createSession(
  app: Bootstrapped,
  runtime: AppRuntime,
): Promise<AppSessionController | null> {
  return createAppSession({
    app,
    runtime,
    crypto: quickCryptoPort,
    clock: systemClock,
    idSource: createUuidV7Generator({
      now: () => systemClock.now(),
      randomBytes: (n) => quickCryptoPort.randomBytes(n),
    }),
  });
}

/**
 * THE NOTES SURFACE (task 119) — the producer `App.notes` was waiting for.
 *
 * The command/query half is Node-safe and composed in `bootstrap/notes.ts`; what this site adds is
 * the MEDIA half, which is native. Both seams are currently `UNWIRED_NOTES_MEDIA` and that is a
 * deliberate, documented state rather than an oversight:
 *
 *   - `capturePhoto` needs the in-app capture flow (a `CameraView` ref reaching `MediaClient.
 *     capturePhoto`), which lives in a screen the notes editor does not yet route to. It REJECTS, so
 *     the button reports a failure instead of silently behaving like a cancel.
 *   - `loadThumbnail` needs the SIGNED sha256/mime to verify a downloaded photo against (06 §6). For
 *     a PULLED note that value does not exist yet: `notes.note_created` carries a bare `mediaId`.
 *     That is task 120's payload change, in flight. Until it lands, `unavailable` is the only answer
 *     06 §6 permits — fetching and rendering unverified bytes is precisely what it forbids.
 *
 * The reads, writes, permission enforcement and live-query invalidation are all REAL regardless: the
 * notes list, detail and editor work over the live database today.
 */
function createNotes(
  app: Bootstrapped,
  runtime: AppRuntime,
  identity: CommandIdentity,
): NotesRuntime {
  return createSessionNotesRuntime({ app, runtime, identity, media: UNWIRED_NOTES_MEDIA });
}

function Bootstrapped(): React.JSX.Element | null {
  return Root({
    boot,
    createSync,
    createEnrollment,
    createMedia,
    createSession,
    createNotes,
    localeStore: fileLocaleStore,
    // The Settings device block, DERIVED from the booted app's persisted state (task 94) rather than
    // a hardcoded empty literal. This is the only site that knows `platform`/`appVersion` (process
    // facts, not DB values); the deviceId + names come from meta_kv.
    readDeviceInfo: (app) =>
      readDeviceInfo(app, {
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
        appVersion: APP_VERSION,
      }),
  });
}

registerRootComponent(Bootstrapped);
