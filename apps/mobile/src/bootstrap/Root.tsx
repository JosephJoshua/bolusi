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
 */
import { useEffect, useReducer, useRef, useState } from 'react';

import App from '../../App.js';
import { bootstrapI18n, type LocaleStorePort } from '../i18n.js';
import { defaultMuteState, type DeviceInfo } from '../screens/settings/model.js';
import { systemClock } from '../ports/clock.js';
import { startLocationWatcher } from '../ports/location.js';
import type { Locale } from '@bolusi/i18n';

import type { Bootstrapped } from './bootstrap.js';
import type { AppEnrollment, EnrollmentController } from './enrollment.js';
import { createNotificationChannels } from './notifications.js';
import { resolveShellInputs } from './shell-inputs.js';
import type { SyncClient } from './sync-client.js';

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
  readonly deviceInfo: DeviceInfo;
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
    onEnrolled: (deviceId: string) => void,
  ) => AppEnrollment;
}

export function Root({
  localeStore,
  deviceInfo,
  boot,
  createSync,
  createEnrollment,
}: RootProps): React.JSX.Element | null {
  const [locale, setLocale] = useState<Locale | null>(null);
  const [app, setApp] = useState<Bootstrapped | null>(null);
  const [enrollment, setEnrollment] = useState<AppEnrollment | null>(null);
  const [sync, setSync] = useState<SyncClient | null>(null);
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
          enroll === null ? undefined : () => enroll.evaluator.onBundleRefresh(),
        ) ?? null;
      if (client === null || disposed) {
        client?.stop();
        return;
      }
      syncRef.current = client;
      unsubRef.current = client.subscribe(() => bump());
      await client.start();
      setSync(client);
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
      const booting = await boot();

      // Wire the enrollment caller over the booted app. `onEnrolled` fires AFTER `runEnrollment`
      // persisted `deviceId`/`storeId` to `meta_kv` (task 88): it re-derives the enrolled `Bootstrapped`
      // (same connection, new deviceId) and starts the loop live — no reboot (task 89). `let` so the
      // callback can close over the value assigned on the same line (called only later, never in TDZ).
      let enroll: AppEnrollment | null = null;
      enroll =
        createEnrollment?.(booting, (deviceId) => {
          const enrolled: Bootstrapped = { ...booting, deviceId };
          setApp(enrolled);
          void startSyncIfEnrolled(enrolled, enroll);
        }) ?? null;
      setEnrollment(enroll);
      setApp(booting);

      // The loop, IFF the device is ALREADY enrolled at boot. `startSyncIfEnrolled` is a no-op when
      // `deviceId` is null, so nothing starts on a device that cannot sync — no faked loop.
      await startSyncIfEnrolled(booting, enroll);
    })();

    return () => {
      disposed = true;
      unsubRef.current?.();
      unsubRef.current = null;
      syncRef.current?.stop();
      syncRef.current = null;
    };
  }, [localeStore, boot, createSync, createEnrollment]);

  // Render nothing until the locale is resolved AND the data layer is up. One frame of the wrong
  // language on the enrollment screen is the first thing this shop would see every morning
  // (07-i18n §1.2) — and a frame of the shell over a database that is not open is the other thing
  // worth never showing.
  if (locale === null || app === null) return null;

  const shell = resolveShellInputs(app, sync, systemClock.now());

  return (
    <App
      device={shell.device}
      users={null}
      usersError={null}
      pinRow={() => null}
      now={systemClock.now()}
      session={null}
      locked={false}
      sync={shell.sync}
      onSyncNow={() => sync?.requestManual()}
      onSubmitPin={() => undefined}
      onSelectLocale={(next) => {
        void localeStore.write('bolusi.device_locale', next);
        setLocale(next);
      }}
      locale={locale}
      deviceInfo={deviceInfo}
      enrollment={enrollment?.controller ?? UNWIRED_ENROLLMENT}
    />
  );
}
