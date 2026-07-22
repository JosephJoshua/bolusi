/**
 * The composition root — the one place that knows about both the platform and the shell.
 *
 * `App` takes every input as a prop (so it is drivable from fakes); this file is what supplies them
 * on a real device. It is the only component `index.ts` registers.
 *
 * ── WHAT IS REAL AND WHAT IS ABSENT, STATED PLAINLY ─────────────────────────────────────────────
 *
 *   REAL:    i18n boot at the device locale (07-i18n §1.2), the notification channels
 *            (api/04-push §5), the clock/location ports, the gate + every screen, THE DATA LAYER
 *            (the SQLCipher key, the encrypted DB, client migrations, module registration, a
 *            `SyncState` READ FROM THE DATABASE), and — since task 89 — THE SYNC LOOP: when the boot
 *            reports an enrolled `deviceId` (`meta_kv`, task 88), `createSync` constructs and starts
 *            the real loop, and this component reads `loopState` / `isOffline` / `SyncState` from that
 *            LIVE client. On the first cycle `lastSuccessfulSyncAt` becomes real and the banner clears.
 *   REAL (task 92):  the ENROLLMENT PATH. `createEnrollment` wires `App`'s `onLogin`/`onEnroll` to the
 *            login + enroll transports → `runEnrollment` → the composed `CommandRuntime`'s genesis
 *            append (bootstrap/runtime.ts) over the production `OpAppendStore` → `deviceId`/`storeId`
 *            persisted (task 88). On enroll SUCCESS `onEnrolled` re-derives the enrolled `Bootstrapped`
 *            and starts the loop LIVE — no reboot — and wires the evaluator's `onBundleRefresh` memo
 *            invalidation into the bundle refresh. A FRESH device still starts unenrolled (`deviceId`
 *            null, no loop) — the true state — until the wizard runs. What stays headless-only is the
 *            on-device/on-server leg (a real POST, SQLCipher at rest), owed to task 27a (D12/D13).
 *
 * ── THE GATE IS STILL A GATE (task 24's property — do not break it) ────────────────────────────
 * `resolveZone` is a pure function of device status + session + lock, recomputed on every render,
 * "so an idle lock can't strand a screen behind a stale route". The bootstrap below does NOT touch
 * that: it resolves BEFORE any zone renders (this component returns `null` until it has), and it
 * feeds the gate's inputs rather than bypassing them. `device` is DERIVED from the real `deviceId`
 * (and `syncDisabled`), so a revoked device beats an enrolled one — the same ordering task 24 tested.
 *
 * ── THE IDLE LOCK, COMPOSED (task 133; api/02-auth §6.4, SEC-AUTH-08) ───────────────────────────
 * `locked` was the literal `false` here. The gate's third input was therefore a constant, nothing
 * called `ShellSession.tick`, and `SessionManager.checkIdle()` had no production caller at all — a
 * security control that was green in eight unit tests and inert on every device. Three lines fixed
 * it and all three are below: `locked` is DERIVED from the session snapshot, `createIdleTicker`
 * drives the check while the app is foregrounded (and once on every resume), and the responder-
 * capture wrapper resets the deadline on interaction so the lock fires on IDLE rather than on
 * elapsed time. The DECISION is still 14's — nothing here re-derives a deadline.
 */
import { useEffect, useReducer, useRef, useState } from 'react';
import { View } from 'react-native';

import App from '../../App.js';
import { bootstrapI18n, type LocaleStorePort } from '../i18n.js';
import { defaultMuteState, type DeviceInfo } from '../screens/settings/model.js';
import { systemClock } from '../ports/clock.js';
import { startLocationWatcher } from '../ports/location.js';
import type { Locale } from '@bolusi/i18n';

import type { Bootstrapped } from './bootstrap.js';
import type { AppEnrollment, EnrollmentController } from './enrollment.js';
import { readSessionIdentity } from './notes.js';
import { createNotificationChannels } from './notifications.js';
import {
  registerPushTokenOnAppStart,
  registerPushTokenOnEnrollment,
  type PushRegistrationPorts,
} from '../push/registration.js';
import {
  resolvePushShellRoute,
  type PushResponse,
  type PushRouteRequest,
  type PushRouterPort,
} from '../push/router.js';
import type { AppRuntime } from './runtime.js';
import type { AppSessionController as AppSession } from './session.js';
import { resolveShellInputs } from './shell-inputs.js';
import type { SyncClient } from './sync-client.js';
import type { AppStatePort } from './triggers.js';
import { createIdleTicker } from '../session/idle-ticker.js';
import { consoleDiagnostics } from '../ports/diagnostics.js';
import type { MediaClient } from '../media/client.js';
import type { CommandIdentity, TimerPort } from '@bolusi/core';
import type { NotesRuntime } from '@bolusi/modules/notes/screens';

/**
 * The fallback enrollment controller when none is injected (Node-driven Root with no `createEnrollment`).
 * It REJECTS rather than no-ops: an unwired enroll button that silently does nothing is the
 * working-looking lie task 24 refuses. Production always injects a real one (index.ts).
 */
const UNWIRED_ENROLLMENT: EnrollmentController = {
  login: () => Promise.reject(new Error('enrollment is not wired (no createEnrollment injected)')),
  enroll: () => Promise.reject(new Error('enrollment is not wired (no createEnrollment injected)')),
};

export interface RootProps {
  /** §1.2's plain local storage. Injected so the root is drivable from Node. */
  readonly localeStore: LocaleStorePort;
  /**
   * Derive the Settings device-info block from the booted app's persisted state (task 94) — injected
   * (like `boot`) so the read lives at the one native-binding site (index.ts supplies `platform` +
   * `appVersion`) and this component stays drivable from Node. Re-read after boot AND after enroll,
   * so a device that enrolls live shows its real identity without a reboot. Replaces the hardcoded
   * empty `deviceInfo` literal that rendered every field blank for an enrolled device.
   */
  readonly readDeviceInfo: (app: Bootstrapped) => Promise<DeviceInfo>;
  /**
   * The data layer, injected.
   *
   * `index.ts` supplies the real one (it is the only file that imports the op-sqlite adapter — a
   * JSI native module that cannot load under Node). Injecting it keeps this component drivable and
   * keeps `bootstrap()` testable against better-sqlite3 in CI, which is what makes the migrations
   * run against a REAL SQLite engine rather than a fake handle.
   */
  readonly boot: () => Promise<Bootstrapped>;
  /**
   * Build the sync client for a booted app, or `null` when the device is not enrolled — injected for
   * the same reason as `boot`: the real one (index.ts) binds NetInfo/AppState (native modules) and
   * the fetch transport, none of which load under Node. Returning `null` for an unenrolled device is
   * the gate the sync loop gates on (bootstrap's `deviceId`), made real rather than commented.
   *
   * `onBundleRefreshed` is passed the evaluator's memo-invalidation hook (02-permissions §6 (a)) so a
   * bundle refresh drops the permission memo; `undefined` when no runtime is composed.
   */
  readonly createSync?: (
    app: Bootstrapped,
    onBundleRefreshed?: () => void | Promise<void>,
  ) => SyncClient | null;
  /**
   * Wire the enrollment caller over a booted app (api/02-auth §4) — injected for the same reason as
   * `boot`: it binds the SecureStore keystore + quick-crypto + the fetch transports (index.ts). Given
   * the app and an `onEnrolled` callback, it returns the controller `App` drives and the evaluator the
   * sync loop invalidates. Absent under Node-driven Root, where the fallback controller rejects.
   */
  readonly createEnrollment?: (
    app: Bootstrapped,
    onEnrolled: (deviceId: string, ownerUserId: string) => void,
  ) => AppEnrollment;
  /**
   * Build the media client for a booted app, or `null` when the device is not enrolled (task 82) —
   * injected for the same reason as `boot` and `createSync`: the real one (index.ts) binds
   * expo-file-system, expo-image-manipulator and expo-background-task, none of which load under Node.
   *
   * It RIDES THE SYNC LOOP'S LIFECYCLE and is deliberately independent of it (FR-1138): started in
   * the same place, for the same enrolled-device condition, and stopped on the same teardown — but
   * neither loop can block the other, because they share no state. A stalled 3 G photo upload must
   * never delay an op push; 06 §1 is explicit that "a note/ticket is usable before its media has
   * uploaded".
   */
  readonly createMedia?: (app: Bootstrapped) => MediaClient | null;
  /**
   * Build the session controller for a booted app, or `null` when the device is not enrolled
   * (task 119) — injected for the same reason as `createSync`: the real one binds quick-crypto and the
   * UUIDv7 source, and returning `null` for an unenrolled device is the honest "there is nobody to
   * sign in as" rather than a controller scoped to a placeholder tenant.
   *
   * THIS IS WHAT MAKES `session` REAL. Before task 119 this component passed `session={null}`,
   * `users={null}` and `onSubmitPin={() => undefined}` as literals, so an enrolled device reached the
   * switcher, listed nobody, and had a PIN pad whose submit did nothing. The shell zone — and every
   * module screen behind it — was unreachable on a real device by construction.
   */
  readonly createSession?: (app: Bootstrapped, runtime: AppRuntime) => Promise<AppSession | null>;
  /**
   * Bind the notes module surface for an open session (task 119) — the producer `App.notes` was
   * waiting for. Injected because its media half binds native modules (camera, file system), the same
   * reason `createMedia` is. Absent ⇒ `notes` stays `undefined` and `home` renders the empty shell,
   * which is exactly the pre-task-119 behaviour.
   */
  readonly createNotes?: (
    app: Bootstrapped,
    runtime: AppRuntime,
    identity: CommandIdentity,
    /**
     * The ALREADY-CONSTRUCTED media client, or `null` on a device that has none. Passed rather than
     * built here so the notes thumbnail path and the upload drain share ONE client over one DB
     * connection — a second client would mean a second drain loop competing for the same rows.
     */
    media: MediaClient | null,
  ) => NotesRuntime;
  /**
   * RN `AppState`, injected — the idle ticker's foreground/resume signal (api/02-auth §6.4).
   *
   * REQUIRED, not optional, and that is the whole point: an optional platform input with a no-op
   * default is how a security control ends up composed on paper and absent on device (this task's
   * entire finding). `tsc` now refuses a `Root` that has no way to run the idle check. It is the same
   * `AppStatePort` the sync triggers take (§2.8) and it is native, so it is bound at `index.ts`.
   */
  readonly appState: AppStatePort;
  /**
   * Core's one-shot `TimerPort` — the idle tick's cadence. Node-safe (`ports/timer.ts` is plain
   * `setTimeout`), but injected rather than imported so a test drives the tick deterministically
   * instead of sleeping (T-6). REQUIRED for the reason `appState` is.
   */
  readonly timer: TimerPort;
  /**
   * Build the push-token registration ports for a booted app + the acting user, or `undefined` when
   * push is not wired (a build with no EAS project id — api/04-push §7; index.ts). Injected for the
   * same reason as `createSync`: `postToken` binds the fetch transport + the SecureStore device bearer,
   * and `getExpoPushTokenAsync` is a native module — none load under Node. `Root` calls
   * `registerPushTokenOnAppStart` with it once a session exists and `registerPushTokenOnEnrollment` on
   * enroll (api/04-push §2). `actingUserId` rides the `X-Acting-User` header: the session user, or
   * `null` pre-login. Push is best-effort (§1), so a failure here NEVER blocks or crashes the boot.
   */
  readonly createPushRegistration?:
    | ((app: Bootstrapped, actingUserId: string | null) => PushRegistrationPorts | undefined)
    | undefined;
  /**
   * The notification-tap seam (api/04-push §4/§6), or `undefined` when unwired — injected because it
   * binds `expo-notifications` (native). `Root` subscribes to warm taps and reads the cold-start tap,
   * resolves each through `resolvePushShellRoute`, and drives the shell's route. A tap NEVER navigates
   * to an unreachable surface (the resolver maps only to `ShellRoute` members) and an unknown payload
   * navigates nowhere.
   */
  readonly pushRouter?: PushRouterPort | undefined;
}

export function Root({
  localeStore,
  readDeviceInfo,
  boot,
  createSync,
  createEnrollment,
  createMedia,
  createSession,
  createNotes,
  appState,
  timer,
  createPushRegistration,
  pushRouter,
}: RootProps): React.JSX.Element | null {
  const [locale, setLocale] = useState<Locale | null>(null);
  const [app, setApp] = useState<Bootstrapped | null>(null);
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
  const [enrollment, setEnrollment] = useState<AppEnrollment | null>(null);
  const [sync, setSync] = useState<SyncClient | null>(null);
  /**
   * The media client, mirrored into state alongside `mediaRef` (task 120).
   *
   * WHY STATE AND NOT JUST THE REF. The notes runtime binds this client once, at the instant a
   * session opens (below). A ref read there is not reactive, so if the client is constructed AFTER
   * the session effect first runs, `createNotes` receives `null`, silently falls back to
   * `UNWIRED_NOTES_MEDIA`, and every note photo renders `unavailable` FOREVER — and because
   * api/03 §8 makes `unavailable` an expected, transient state, nothing throws, nothing logs, and no
   * test reds. That is the "silently checks nothing" class (CLAUDE.md §2.11): the honest answer to
   * "if this binding were wrong, what would notice?" would be "nothing". Holding the client in state
   * — exactly as `sync` is held in both `syncRef` and `setSync` — makes the session effect re-run
   * when the client lands, so the binding is correct by construction rather than by boot ordering.
   */
  const [media, setMedia] = useState<MediaClient | null>(null);
  const [session, setSession] = useState<AppSession | null>(null);
  /**
   * The deep link a notification tap requested (api/04-push §4), handed to `App` to apply. A FRESH
   * object per tap, set ONLY by the push-router effect below (never on an unrelated render), so `App`'s
   * effect re-navigates on each tap but not on every render. `null` until the first tap.
   */
  const [pushRoute, setPushRoute] = useState<PushRouteRequest | null>(null);
  /**
   * The notes surface for the CURRENT session (task 119).
   *
   * Keyed by userId, and rebuilt when it changes, because a `NotesRuntime` closes over a
   * `CommandIdentity` — reusing one across a user switch would attribute the incoming user's notes to
   * the outgoing user, which is the attribution failure the switcher exists to prevent (04 §5.2). Null
   * whenever no session is open, so the shell falls back to the empty `home` rather than holding a
   * runtime scoped to somebody who has signed out.
   */
  const [notes, setNotes] = useState<{
    readonly userId: string;
    readonly runtime: NotesRuntime;
  } | null>(null);
  // A monotonic tick the live client bumps on every loop/connectivity change, so the shell re-reads
  // `loopState` / `isOffline` / `SyncState` from it. Without this, the banner would never clear on
  // the first sync — the value would be right in the DB and stale on screen.
  const [, bump] = useReducer((n: number) => n + 1, 0);
  // The sync client lives OUTSIDE the effect's re-run cycle: it is constructed at most once (at boot
  // if enrolled, or on enroll success), and only stopped on unmount. Holding it in a ref rather than
  // reconstructing it per render is what lets `onEnrolled` start the loop WITHOUT the boot effect
  // re-running and stopping the loop it just started.
  const syncRef = useRef<SyncClient | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  /** The media client (task 82), held for the same reason as `syncRef`: constructed at most once. */
  const mediaRef = useRef<MediaClient | null>(null);
  /**
   * The `AppRuntime` whose step-7 hook currently points at the live loop (task 136), held in a ref so
   * the effect's teardown can detach it — the cleanup closure cannot see the `enroll` local, which is
   * created inside the async body. Detaching matters because the loop is stopped on the same
   * teardown: a scheduler left pointing at stopped triggers would arm a debounce nothing tears down.
   */
  const boundRuntimeRef = useRef<AppRuntime | null>(null);
  /** The session controller (task 119), held for the same reason: constructed at most once. */
  const sessionRef = useRef<AppSession | null>(null);
  const sessionUnsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let disposed = false;

    // Construct + start the loop for an enrolled device — idempotent (a second call is a no-op once
    // the ref holds a client). Primes the evaluator first (§6 bootstrap rule) and wires its memo
    // invalidation to the bundle refresh, so a directory change drops the memo (02-permissions §6 (a)).
    const startSyncIfEnrolled = async (
      booted: Bootstrapped,
      enroll: AppEnrollment | null,
    ): Promise<void> => {
      if (disposed || syncRef.current !== null || booted.deviceId === null) return;
      if (enroll !== null) await enroll.evaluator.prime();
      const client =
        createSync?.(
          booted,
          enroll === null
            ? undefined
            : async () => {
                await enroll.evaluator.onBundleRefresh();
                // The tenant's `idleLockSeconds` rides the same bundle (api/02-auth §6.4) and
                // `applyBundle` has just persisted it. Read through the REF, not a captured value:
                // this callback is created before the session controller exists, and a bundle
                // refresh that landed a tighter timeout in the database while the session kept the
                // old one is a setting that "took effect" nowhere the user could see.
                await sessionRef.current?.refreshSettings();
              },
        ) ?? null;
      if (client === null || disposed) {
        client?.stop();
        return;
      }
      syncRef.current = client;
      unsubRef.current = client.subscribe(() => bump());
      await client.start();
      // ── STEP 7 GETS ITS PRODUCER (04 §5.1; api/01-sync §5 (b); task 136) ────────────────────────
      // The one place in the app where the runtime and the loop are both in scope, which is the only
      // place this bind can happen: the runtime is built BEFORE any loop (it appends the genesis that
      // produces the `deviceId` a client needs), so it carries an indirected step-7 hook that is inert
      // until pointed at a real trigger. Until this line existed the app bound
      // `{ schedule: () => undefined }` and every local append scheduled a sync into nothing.
      //
      // AFTER `start()`, deliberately: `hydrate()` runs there, and `SyncLoop.requestSync` throws on an
      // un-hydrated loop. The scheduler must never throw (a locally durable op is a successful
      // command), so it is not reachable before the loop can answer.
      enroll?.runtime.bindSyncScheduler(client.scheduler);
      boundRuntimeRef.current = enroll?.runtime ?? null;
      setSync(client);
    };

    /**
     * The media pipeline (task 82) — 06 §5.1's drain loop, §5.2's triggers, §5.4's background task
     * and §7's pruning pass, for an enrolled device.
     *
     * Deliberately NOT awaited inside `startSyncIfEnrolled`, and not gated on it: FR-1138 says the
     * two loops are independent, and a media start that failed (a background registration the OS
     * refused, say) must not stop the op sync from running. Its own `start()` reports what happened
     * rather than throwing (`MediaStartReport`), so a failure here is visible without being fatal.
     */
    const startMediaIfEnrolled = async (booted: Bootstrapped): Promise<void> => {
      if (disposed || mediaRef.current !== null || booted.deviceId === null) return;
      const client = createMedia?.(booted) ?? null;
      if (client === null || disposed) {
        client?.stop();
        return;
      }
      mediaRef.current = client;
      // Mirror into state so the notes session effect re-runs and binds the REAL client, rather than
      // whatever `mediaRef.current` happened to be when it first ran (see the `media` state comment).
      setMedia(client);
      await client.start();
    };

    /**
     * The session controller (task 119), for an enrolled device — idempotent, like the two above.
     *
     * Gated on `deviceId` for the same reason the loop is: an unenrolled device has no directory to
     * list and no identity to emit session ops under. It needs the SAME `AppRuntime` the enrollment
     * caller built (`enroll.runtime`), so session ops, the genesis, and every note write share one op
     * store and one enforcement point (§2.8) — which is why this runs after `createEnrollment`.
     */
    const startSessionIfEnrolled = async (
      booted: Bootstrapped,
      enroll: AppEnrollment | null,
    ): Promise<void> => {
      if (disposed || sessionRef.current !== null || booted.deviceId === null) return;
      if (enroll === null) return;
      const controller = (await createSession?.(booted, enroll.runtime)) ?? null;
      if (controller === null || disposed) return;
      sessionRef.current = controller;
      sessionUnsubRef.current = controller.subscribe(() => bump());
      setSession(controller);
      // The roster the switcher renders. Without this the switcher's `users` stays null and nobody
      // can be tapped — the surface would render its loading state forever.
      await controller.refresh();
    };

    void (async () => {
      // Order matters (08 §6.3). i18n FIRST, because the notification channels' NAMES are catalog
      // strings and Android keeps whatever name it is first given.
      const booted = await bootstrapI18n(localeStore);
      setLocale(booted);
      await createNotificationChannels(defaultMuteState());
      await startLocationWatcher();

      // The data layer. Deliberately NOT wrapped in a try/catch that renders the shell anyway: a
      // failure here means the app has no database, and booting the screens over that would be the
      // working-looking shape this task exists to refuse (02 §3.2: a startup failure, not a warning).
      //
      // NAMING THE CASES THIS NO-CATCH DOES NOT HANDLE (security-guide §6.6; task 91): this stance is
      // right for a genuinely corrupt or transiently unopenable DB — fail loud, don't fake a shell.
      // It was WRONG for exactly one case it silently also decided not to handle: a restored device
      // (an iOS restore-to-new-hardware restores `bolusi.db` but not its THIS_DEVICE_ONLY key), whose
      // wrong-key open is not a corrupt DB but a fresh device wearing old ciphertext. That case is now
      // healed INSIDE the injected `boot` (index.ts wires `bootWithLocalRecovery`, which wipes and
      // re-enrols on `not_a_database`/`missing_key`), so by the time it resolves here the DB is either
      // openable or genuinely failed — and this no-catch is retained ONLY for the latter. A comment
      // that justifies not handling an error must say which errors; this one now does.
      const booting = await boot();

      // Wire the enrollment caller over the booted app. `onEnrolled` fires AFTER `runEnrollment`
      // persisted `deviceId`/`storeId` to `meta_kv` (task 88): it re-derives the enrolled `Bootstrapped`
      // (same connection, new deviceId) and starts the loop live — no reboot (task 89). `let` so the
      // callback can close over the value assigned on the same line (called only later, never in TDZ).
      let enroll: AppEnrollment | null = null;
      enroll =
        createEnrollment?.(booting, (deviceId, ownerUserId) => {
          const enrolled: Bootstrapped = { ...booting, deviceId };
          setApp(enrolled);
          // Re-derive the Settings device-info NOW: enrollment.ts persisted the device/store/tenant
          // names to meta_kv before firing this, so this read surfaces the real identity live, no
          // reboot (task 94). Without it the just-enrolled device would keep the pre-enroll blanks.
          void readDeviceInfo(enrolled).then((info) => {
            if (!disposed) setDeviceInfo(info);
          });
          void startSyncIfEnrolled(enrolled, enroll);
          void startMediaIfEnrolled(enrolled);
          // The device just became enrolled — the switcher can now list users and a PIN can open a
          // session, live, without a reboot (the same no-reboot rule the loop follows).
          void startSessionIfEnrolled(enrolled, enroll);
          // Register the push token immediately post-enrollment (api/04-push §2 (b)) — ALWAYS, so the
          // server stamps `user_id` for the just-enrolled device even if the token has not changed.
          // The acting user is the OWNER who enrolled (the only user known at this instant; no PIN
          // session is open yet — the gate shows the switcher next). Fire-and-forget: push is
          // best-effort and this must not delay or fail the enroll-success path (§1).
          if (createPushRegistration !== undefined) {
            const ports = createPushRegistration(enrolled, ownerUserId);
            if (ports !== undefined) void registerPushTokenOnEnrollment(ports);
          }
        }) ?? null;
      setEnrollment(enroll);
      setApp(booting);
      // The device-info the Settings screen renders (task 94). On a fresh, never-enrolled device this
      // is the honest empty block; on a device enrolled in a PRIOR run it is the real persisted
      // identity — read here rather than handed in as a literal.
      setDeviceInfo(await readDeviceInfo(booting));

      // The loop, IFF the device is ALREADY enrolled at boot. `startSyncIfEnrolled` is a no-op when
      // `deviceId` is null, so nothing starts on a device that cannot sync — no faked loop.
      await startSyncIfEnrolled(booting, enroll);
      await startMediaIfEnrolled(booting);
      await startSessionIfEnrolled(booting, enroll);
    })();

    return () => {
      disposed = true;
      unsubRef.current?.();
      unsubRef.current = null;
      // Detach step 7 BEFORE stopping the loop, so no append can arm a debounce on triggers that are
      // about to be torn down. Back to inert — the same state the runtime is built in.
      boundRuntimeRef.current?.bindSyncScheduler(null);
      boundRuntimeRef.current = null;
      syncRef.current?.stop();
      syncRef.current = null;
      mediaRef.current?.stop();
      mediaRef.current = null;
      setMedia(null);
      sessionUnsubRef.current?.();
      sessionUnsubRef.current = null;
      sessionRef.current = null;
    };
  }, [
    localeStore,
    boot,
    createSync,
    createEnrollment,
    createMedia,
    createSession,
    readDeviceInfo,
    createPushRegistration,
  ]);

  const sessionSnapshot = session?.snapshot() ?? null;
  const sessionUserId = sessionSnapshot?.session?.userId ?? null;

  /**
   * THE IDLE TICK (task 133; api/02-auth §6.4) — the production caller `SessionManager.checkIdle()`
   * never had.
   *
   * Keyed on the session CONTROLLER, not on the open session: the controller is what owns the shell
   * session and the deadline, and it outlives every individual lock/unlock. Keying on `sessionUserId`
   * would stop the ticker the moment a lock cleared the identity — i.e. exactly when the shell most
   * needs to keep asking — and would restart the interval on every switch.
   *
   * The cleanup is not tidiness: `stop()` cancels the pending one-shot and unsubscribes `AppState`.
   * A leaked ticker over an unmounted tree would go on emitting `session_ended` ops into the log.
   */
  useEffect(() => {
    if (session === null) return;
    const ticker = createIdleTicker({
      tick: () => session.tick(),
      timer,
      appState,
      // A tick can only fail by failing to append `session_ended`. Route it to the app's ONE client
      // diagnostics channel (§2.8) rather than swallowing it — a lock that believes it happened and
      // a log that has no record of it is precisely the silent state this task exists to remove.
      onError: (error) =>
        consoleDiagnostics.warn('idle lock tick failed', {
          error: error instanceof Error ? error.message : String(error),
        }),
    });
    ticker.start();
    return () => ticker.stop();
  }, [session, timer, appState]);

  /**
   * PUSH-TOKEN REGISTRATION, once a session exists (api/04-push §2 (a)) — the production caller
   * `registerPushTokenOnAppStart` never had (this task's finding: the function shipped with unit tests
   * and ZERO importers). Keyed on the enrolled app + the session user, so it fires when a PIN opens a
   * session and re-checks on a user switch. The acting user rides `X-Acting-User` so the server stamps
   * `user_id` (§2/§4); it is diff-gated inside (an unchanged token issues no request), and it swallows
   * offline/permission-denied/token-unavailable to `skipped` — a device that refuses notifications
   * still boots and works (deliverable 3; §1 "push is best-effort and never load-bearing"). Gated on a
   * NON-null `deviceId` because an unenrolled device has no bearer to register with.
   */
  useEffect(() => {
    if (createPushRegistration === undefined) return;
    if (app === null || app.deviceId === null || sessionUserId === null) return;
    // The factory may decline (a build with no EAS project id, api/04-push §7) — then push simply is
    // not registered, and the boot is unaffected (§1).
    const ports = createPushRegistration(app, sessionUserId);
    if (ports !== undefined) void registerPushTokenOnAppStart(ports);
  }, [app, sessionUserId, createPushRegistration]);

  /**
   * THE NOTIFICATION-TAP ROUTER (api/04-push §4/§6) — the production caller `resolvePushRoute` never
   * had. Subscribe to warm taps AND read the cold-start tap that launched the app from a killed state,
   * resolve each through `resolvePushShellRoute`, and hand `App` a route to apply. `null` (an unknown
   * route, a missing id, a `sync` data-only wake) sets NOTHING — the positive control that keeps
   * "always navigates" from passing. A fresh object per tap so a repeat tap re-navigates.
   */
  useEffect(() => {
    if (pushRouter === undefined) return;
    const handle = (response: PushResponse): void => {
      const route = resolvePushShellRoute(response.data);
      if (route !== null) setPushRoute({ route });
    };
    const unsubscribe = pushRouter.subscribeToResponses(handle);
    void pushRouter.getInitialResponse().then((initial) => {
      if (initial !== null) handle(initial);
    });
    return unsubscribe;
  }, [pushRouter]);

  /**
   * THE ACTIVATION (task 119): a session exists ⇒ build the notes surface for that user.
   *
   * This effect is the producer `App.notes` never had. It runs on the session's USER ID, so signing
   * out drops the runtime and switching users builds a new one rather than carrying the previous
   * user's `CommandIdentity` into the incoming user's screens.
   *
   * `readSessionIdentity` can answer `null` (an unenrolled device); that leaves `notes` null and the
   * shell renders the empty `home` — the honest "this device cannot query yet" rather than a runtime
   * scoped to a tenant that does not exist.
   */
  useEffect(() => {
    if (
      app === null ||
      enrollment === null ||
      createNotes === undefined ||
      sessionUserId === null
    ) {
      setNotes(null);
      return;
    }
    let cancelled = false;
    void readSessionIdentity(app, sessionUserId).then((identity) => {
      if (cancelled || identity === null) return;
      setNotes({
        userId: sessionUserId,
        // `media` (state), not `mediaRef.current`: reading the reactive value with `media` in the
        // deps means this effect RE-RUNS and re-binds when the client lands, so the notes runtime
        // never gets stuck on the `null` it saw before the media pipeline started (06 §6 thumbnail
        // verify needs a real client — a stale null would silently downgrade every photo to
        // `unavailable`, the failure the `media` state comment describes).
        runtime: createNotes(app, enrollment.runtime, identity, media),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [app, enrollment, createNotes, sessionUserId, media]);

  // Render nothing until the locale is resolved AND the data layer is up. One frame of the wrong
  // language on the enrollment screen is the first thing this shop would see every morning
  // (07-i18n §1.2) — and a frame of the shell over a database that is not open is the other thing
  // worth never showing. `deviceInfo` resolves in the same boot pass (from the same booted app), so
  // gating on it here costs no extra wait and keeps the Settings screen from rendering blanks.
  if (locale === null || app === null || deviceInfo === null) return null;

  const shell = resolveShellInputs(app, sync, systemClock.now());
  const openSession = sessionSnapshot?.session ?? null;
  /**
   * The notes runtime, IFF it belongs to the user who is signed in right now.
   *
   * The `userId` comparison is not defensive noise: `notes` is set asynchronously, so a fast user
   * switch can land a runtime built for the OUTGOING user into state after the INCOMING user's
   * session opened. Handing that to the screens would file the new user's notes under the old user's
   * identity — silently, and permanently, in a signed op. Mismatch ⇒ `undefined` ⇒ the empty shell
   * for one frame, until this effect catches up.
   */
  const notesForSession =
    openSession !== null && notes !== null && notes.userId === openSession.userId
      ? notes.runtime
      : undefined;

  return (
    /**
     * THE ACTIVITY RESET (api/02-auth §6.4 — "any interaction resets the idle deadline"), as RN's
     * gesture-responder CAPTURE phase.
     *
     * `onStartShouldSetResponderCapture` runs for every touch that STARTS inside this view, before
     * any child can claim the responder, and returning `false` declines to capture — so this
     * observes every tap in the app without intercepting a single one. It is the one place that can
     * see all interaction without every screen having to remember to report it, which matters
     * because a screen that forgot would lock a user mid-work and teach the shop to raise
     * `idleLockSeconds` to its ceiling (§6.4; SwitcherScreen.tsx:11 makes the same argument).
     *
     * HONEST LIMIT: this sees touch STARTS. A user typing on a hardware keyboard, or reading without
     * touching, is idle by this definition and will be locked — which is the spec's definition too
     * ("idle"), but it is a definition, and it is stated here rather than left to be discovered.
     * `View` is layout-neutral (`flex: 1` over `App`'s own fill), so the tree geometry is unchanged.
     */
    <View
      style={FILL}
      testID="root-activity"
      onStartShouldSetResponderCapture={() => {
        session?.recordActivity();
        return false;
      }}
    >
      <App
        device={shell.device}
        users={sessionSnapshot?.users ?? null}
        usersError={sessionSnapshot?.usersError ?? null}
        pinRow={(userId) => session?.pinRow(userId) ?? null}
        now={systemClock.now()}
        session={openSession === null ? null : { userId: openSession.userId }}
        notes={notesForSession}
        // DERIVED, never a literal (task 133). `false` here made an idle lock indistinguishable from
        // a sign-out: `resolveZone` would render the switcher in `choose` mode, with a header back
        // that walks straight into the previous user's session (design-system §8.2).
        locked={sessionSnapshot?.locked ?? false}
        sync={shell.sync}
        onSyncNow={() => sync?.requestManual()}
        // The PIN pad's one egress (task 24's PinPad contract), and — since task 133 — the UNLOCK
        // path too: the controller runs the REAL `verifyPin` and, on success, `ShellSession.unlock`,
        // which restores this user's retained workspace and clears the lock. The subscription above
        // re-renders the shell, which is what moves the gate from `pin` to `shell`.
        //
        // The boolean is what lets the shell retire the pending PIN target (see `AppProps.onSubmitPin`).
        // The `catch` reports FALSE rather than rethrowing: every EXPECTED failure is already an
        // outcome arm (`wrong` / `gated` / `needs_first_pin`), so a throw here is an infrastructure
        // fault — and the honest response to one is "you are not signed in", which is exactly what
        // false renders. Rethrowing would surface as an unhandled rejection and change nothing on
        // screen; that swallow is what hid a real wiring defect during this task's own bring-up.
        onSubmitPin={(userId, pin) =>
          session === null
            ? Promise.resolve(false)
            : session
                .submitPin(userId, pin)
                .then((outcome) => outcome.kind === 'opened')
                .catch(() => false)
        }
        onSelectLocale={(next) => {
          void localeStore.write('bolusi.device_locale', next);
          setLocale(next);
        }}
        locale={locale}
        deviceInfo={deviceInfo}
        enrollment={enrollment?.controller ?? UNWIRED_ENROLLMENT}
        // The notification-tap deep link (api/04-push §4), or null until a tap resolves to a reachable
        // route. `App` applies it via `setRoute`; the gate still decides what actually shows.
        pushRoute={pushRoute}
      />
    </View>
  );
}

/** The activity-wrapper's fill — layout-neutral over `App`'s own `flex: 1` root. */
const FILL = { flex: 1 } as const;
