import { registerRootComponent } from 'expo';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { createUuidV7Generator, type CommandIdentity } from '@bolusi/core';
import type { NotesRuntime } from '@bolusi/modules/notes/screens';
import { DEFAULT_DATABASE_NAME } from '@bolusi/db-client';
import { deleteOpSqliteDatabase, openOpSqliteDriver } from '@bolusi/db-client/op-sqlite';

import { bootstrap, type Bootstrapped } from './src/bootstrap/bootstrap.js';
import { bootWithLocalRecovery } from './src/bootstrap/recovery.js';
import { pushProjectId, requireApiBaseUrl } from './src/bootstrap/config.js';
import { createEnrollTransport, createLoginTransport } from './src/bootstrap/enroll-transport.js';
import {
  createAppEnrollment,
  type AppEnrollment,
  type EnrollmentPlatform,
} from './src/bootstrap/enrollment.js';
import { readDeviceInfo } from './src/bootstrap/device-info.js';
import { createSessionNotesRuntime, notesMediaSeamsFor } from './src/bootstrap/notes.js';
import type { PushRegistrationPorts } from './src/push/registration.js';
import { createFetchPushTransport } from './src/push/transport.js';
import type { PushResponse, PushRouterPort } from './src/push/router.js';
import { Root } from './src/bootstrap/Root.js';
import type { AppRuntime } from './src/bootstrap/runtime.js';
import { createAppSession, type AppSessionController } from './src/bootstrap/session.js';
import { createSyncClientForApp, type SyncClient } from './src/bootstrap/sync-client.js';
import type { MediaClient } from './src/media/client.js';
import { createMediaClientForApp } from './src/media/native.js';
import { createExpoCapturePlatform } from './src/media/native-capture.js';
import { createFetchMediaTransport } from './src/media/transport.js';
import { appStatePort } from './src/ports/app-state.js';
import { systemClock } from './src/ports/clock.js';
import { deviceColumnAead } from './src/ports/aead.js';
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
 * better-sqlite3 in CI and against op-sqlite on device, through identical code — with the SAME
 * app-layer column cipher on both (D22), so at-rest behaviour is no longer platform-dependent.
 *
 * The op-sqlite CONFIG (`performanceMode: true`) is not here and cannot be: 08 §2.2 says it goes in
 * `package.json`'s `op-sqlite` block, read at native build time. It is there. **`sqlcipher` is NOT
 * set, deliberately** (D22/task 148: it vendored a second `libcrypto.so` and the Android APK would
 * not link). At-rest confidentiality is the app-layer column cipher wired below via `aead`.
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
  // ONE key store serves BOTH the boot (mint/read the at-rest column-encryption key — security-guide §6.4; quick-
  // crypto is the CSPRNG, §6.4/D8) AND the recovery wipe (crypto-erase that key).
  const keyStore = new SecureStoreDbKeyStore(quickCryptoPort);
  // `bootWithLocalRecovery` self-heals a boot that fails because the data layer is genuinely
  // unopenable — a corrupt file that throws `not_a_database`/`missing_key` — by wiping and dropping
  // to enrollment; every other failure still surfaces through Root's no-catch.
  //
  // ⚠️ POST-D22 THIS NO LONGER COVERS THE CASE IT WAS BUILT FOR (recovery.ts `KNOWN GAP SINCE D22`,
  // task 160). It was built for iOS restore-to-new-hardware (security-guide §6.6): `bolusi.db`
  // restores, the THIS_DEVICE_ONLY key does not. Under SQLCipher that was a LOUD `not_a_database` that
  // routed here. Now `open()` takes no key and the restored PLAINTEXT file OPENS successfully, so
  // neither trigger fires — boot "succeeds" into a silent half-enrolled state that throws AEAD errors
  // deep in the UI. Detecting it needs a decrypt-probe at boot (task 160), not this error-class check.
  return bootWithLocalRecovery({
    boot: () =>
      bootstrap({
        driverFactory: openOpSqliteDriver,
        keyStore,
        crypto: quickCryptoPort,
        // D22: the 32-byte SecureStore key now drives app-layer AES-256-GCM over the sensitive columns
        // (via quick-crypto's OpenSSL), replacing SQLCipher's whole-file encryption — task 148.
        aead: deviceColumnAead,
        clock: systemClock,
      }),
    // The api/02-auth §7.3 wipe legs this recovery owns, IN ORDER: (1) crypto-erase the column-cipher
    // key FIRST (from this moment the PROTECTED COLUMNS are unrecoverable — the file itself is still a
    // readable SQLite file since D22, so this is a value-erase, not a file-erase), then (2) delete the DB file(s) +
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
  onEnrolled: (deviceId: string, ownerUserId: string) => void,
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
    // NO `syncScheduler` HERE ANY MORE (task 136), and its absence is the fix rather than an
    // omission. This site used to bind `{ schedule: () => undefined }` — "honest, no loop runs during
    // enrollment" — but the object it fed is the app's ONE `AppRuntime`, reused by the session
    // controller and every notes command, so step 7 (04 §5.1) called that no-op after EVERY local
    // append forever and §5 (b)'s 3 s debounce did not exist on a device. It went unnoticed because
    // NOTHING imports this file: corrupting the binding to throw failed zero tests. The step-7 hook is
    // now owned by `createAppRuntime` and pointed at the real `SyncClient.scheduler` by `Root` — a
    // decision that lives where a composed test can watch it (test/live-shell-sync-scheduler.test.tsx)
    // instead of here, where nothing can.
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
 * the MEDIA half, which is native. BOTH seams are now real:
 *
 * `loadThumbnail` became real in task 120. It was `unavailable` because 06 §6 needs the signed
 * sha256/mime to verify a downloaded photo against, and schemaVersion 2's `notes.note_created`
 * carried only a bare `mediaId` — so for a PULLED note no hash existed on this device at any price.
 * schemaVersion 3 carries the whole signed `mediaRef`, so the verify has something to check against
 * and the bridge binds to the real media client. A device with no media client still gets the honest
 * `unavailable` seams rather than a thumbnail loader that cannot load.
 *
 * `capturePhoto` became real in task 130. It was the rejecting `UNWIRED_NOTES_MEDIA` seam because
 * the in-app capture flow — a `CameraView` ref reaching `MediaClient.capturePhoto` — lived in a
 * screen nothing routed to, and no task owned the wiring (18 and 82 are both `done`). `Root` now
 * hosts that flow (`media/CaptureHost.tsx`) and hands the seam in here, so the editor's attach button
 * opens a camera instead of throwing. A build with no `capturePlatform`, or a device with no media
 * client, still gets the REJECTING seam — never a stub that resolves `null` and reads as a cancel.
 *
 * The reads, writes, permission enforcement and live-query invalidation are all REAL regardless: the
 * notes list, detail and editor work over the live database today.
 */
function createNotes(
  app: Bootstrapped,
  runtime: AppRuntime,
  identity: CommandIdentity,
  media: MediaClient | null,
  capturePhoto: NotesRuntime['capturePhoto'],
): NotesRuntime {
  return createSessionNotesRuntime({
    app,
    runtime,
    identity,
    media: notesMediaSeamsFor(media, capturePhoto),
  });
}

/**
 * THE PUSH-TOKEN REGISTRATION PORTS (api/04-push §2) — bound to the native seams `registration.ts`
 * leaves to the composition root: `getExpoPushTokenAsync` (native, inside `registration.ts`), the
 * `POST /v1/push/tokens` transport (device bearer, read per call from SecureStore), and the
 * last-registered value in plain local storage.
 *
 * The last-registered token lives in the SHARED prefs file `fileLocaleStore` owns (07-i18n §1.2's
 * "plain local storage") rather than a second file store (§2.8 — one implementation): it is unsigned
 * UI state, not a secret, so it does NOT belong behind the SecureStore keystore (which owns exactly the
 * two credentials of api/02-auth §3). `null` for an unenrolled device (no `deviceId`, no bearer) or an
 * absent EAS project id (`pushProjectId` is `null` until task 21 wires FCM/EAS) — either way `Root`
 * simply does not register, and the boot is unaffected (push is best-effort, §1).
 */
const PUSH_LAST_REGISTERED_KEY = 'bolusi.push_last_registered';

function createPushRegistration(
  app: Bootstrapped,
  actingUserId: string | null,
): PushRegistrationPorts | undefined {
  const projectId = pushProjectId(process.env['EXPO_PUBLIC_PROJECT_ID']);
  if (projectId === null || app.deviceId === null) return undefined;
  const keystore = new SecureStoreKeyStore();
  const postToken = createFetchPushTransport({
    baseUrl: apiBaseUrl(),
    deviceId: app.deviceId,
    deviceToken: () => keystore.loadDeviceToken(),
  });
  return {
    projectId,
    readLastRegistered: () => fileLocaleStore.read(PUSH_LAST_REGISTERED_KEY),
    writeLastRegistered: (token) => fileLocaleStore.write(PUSH_LAST_REGISTERED_KEY, token),
    postToken: (expoPushToken) => postToken(expoPushToken, actingUserId),
    // Best-effort diagnostics through the app's ONE client channel (§2.8), never a bare console: a
    // token that could not be acquired or POSTed is expected offline, and must not surface as an error.
    onError: (error) =>
      consoleDiagnostics.warn('push token registration failed', {
        error: error instanceof Error ? error.message : String(error),
      }),
  };
}

/**
 * THE NOTIFICATION-TAP SEAM (api/04-push §4/§6) — bound over `expo-notifications` (native, so bound
 * HERE like the other native modules). Warm taps via `addNotificationResponseReceivedListener`; the
 * cold-start tap (killed-app delivery, §6) via `getLastNotificationResponseAsync`. Each yields the
 * payload's `content.data`, which `Root` resolves to a reachable route — verified against SDK 57's API
 * (Context7). No permission is needed to LISTEN for a tap; token acquisition handles denial by skipping.
 */
function pushResponseData(
  response: Notifications.NotificationResponse | null,
): PushResponse | null {
  return response === null ? null : { data: response.notification.request.content.data };
}

const expoPushRouter: PushRouterPort = {
  subscribeToResponses(handler) {
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      handler({ data: response.notification.request.content.data });
    });
    return () => subscription.remove();
  },
  async getInitialResponse() {
    return pushResponseData(await Notifications.getLastNotificationResponseAsync());
  },
};

function Bootstrapped(): React.JSX.Element | null {
  return Root({
    boot,
    createSync,
    createEnrollment,
    createMedia,
    createSession,
    createNotes,
    // THE PUSH VERTICAL, CLIENT HALF (api/04-push §2/§4; task 135). `createPushRegistration` returns
    // `undefined` on an unenrolled device or a build with no EAS project id — `Root` then simply does
    // not register (push is best-effort, §1). `expoPushRouter` binds the native tap listener so a
    // notification deep-links into the reachable shell route.
    createPushRegistration,
    pushRouter: expoPushRouter,
    // THE IDLE LOCK'S PLATFORM INPUTS (api/02-auth §6.4; task 133). `appStatePort` is the same native
    // `AppState` binding the sync triggers take (§2.8) and is bound here for the same reason NetInfo
    // is; `systemTimer` is the app's one `setTimeout`. Both are REQUIRED props on `Root`, so a build
    // that fails to supply them does not compile — which is the only reason this composition cannot
    // quietly go missing again the way `ShellSession` did.
    appState: appStatePort,
    timer: systemTimer,
    // THE IN-APP CAMERA'S NATIVE SEAMS (06 §2.1; task 130) — `expo-camera`'s permission call, its
    // `CameraView` and the still renderer, bound at the one site that may import them. Supplying
    // this is what turns the notes editor's attach button from a rejecting stub into a camera, and
    // what gives 06 §7's storage banners their first production render.
    capturePlatform: createExpoCapturePlatform(),
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
