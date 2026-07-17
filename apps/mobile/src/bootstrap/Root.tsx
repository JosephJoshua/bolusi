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
 *   ABSENT:  the ENROLLMENT PATH. `App`'s `onEnroll`/`onLogin` are still inert, and — more
 *            fundamentally — a production device cannot become enrolled: `runEnrollment`'s genesis
 *            append needs a composed `CommandRuntime` (an `OpAppendStore` over db-client) that no task
 *            has built yet (the mobile command-runtime composition task). So `boot().deviceId` is null
 *            on a real device, `createSync` returns null, and no loop starts — the TRUE state, read,
 *            not a stub. The moment enrollment persists a `deviceId`, this constructs the loop.
 *
 * ── THE GATE IS STILL A GATE (task 24's property — do not break it) ────────────────────────────
 * `resolveZone` is a pure function of device status + session + lock, recomputed on every render,
 * "so an idle lock can't strand a screen behind a stale route". The bootstrap below does NOT touch
 * that: it resolves BEFORE any zone renders (this component returns `null` until it has), and it
 * feeds the gate's inputs rather than bypassing them. `device` is DERIVED from the real `deviceId`
 * (and `syncDisabled`), so a revoked device beats an enrolled one — the same ordering task 24 tested.
 */
import { useEffect, useReducer, useState } from 'react';

import App from '../../App.js';
import { bootstrapI18n, type LocaleStorePort } from '../i18n.js';
import { defaultMuteState, type DeviceInfo } from '../screens/settings/model.js';
import { systemClock } from '../ports/clock.js';
import { startLocationWatcher } from '../ports/location.js';
import type { Locale } from '@bolusi/i18n';

import type { Bootstrapped } from './bootstrap.js';
import { createNotificationChannels } from './notifications.js';
import { resolveShellInputs } from './shell-inputs.js';
import type { SyncClient } from './sync-client.js';

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
   */
  readonly createSync?: (app: Bootstrapped) => SyncClient | null;
}

export function Root({
  localeStore,
  deviceInfo,
  boot,
  createSync,
}: RootProps): React.JSX.Element | null {
  const [locale, setLocale] = useState<Locale | null>(null);
  const [app, setApp] = useState<Bootstrapped | null>(null);
  const [sync, setSync] = useState<SyncClient | null>(null);
  // A monotonic tick the live client bumps on every loop/connectivity change, so the shell re-reads
  // `loopState` / `isOffline` / `SyncState` from it. Without this, the banner would never clear on
  // the first sync — the value would be right in the DB and stale on screen.
  const [, bump] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    let client: SyncClient | null = null;
    let unsubscribe: (() => void) | null = null;
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
      setApp(booting);

      // The sync loop, IFF the device is enrolled. `createSync` returns null for an unenrolled device
      // (deviceId === null), so nothing starts on a device that cannot sync — no faked loop.
      client = createSync?.(booting) ?? null;
      if (client !== null) {
        unsubscribe = client.subscribe(() => bump());
        await client.start();
        setSync(client);
      }
    })();
    return () => {
      unsubscribe?.();
      client?.stop();
    };
  }, [localeStore, boot, createSync]);

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
    />
  );
}
