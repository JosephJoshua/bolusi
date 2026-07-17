/**
 * The composition root — the one place that knows about both the platform and the shell.
 *
 * `App` takes every input as a prop (so it is drivable from fakes); this file is what supplies them
 * on a real device. It is the only component `index.ts` registers.
 *
 * ── WHAT IS REAL AND WHAT IS ABSENT, STATED PLAINLY ─────────────────────────────────────────────
 *
 *   REAL:    i18n boot at the device locale (07-i18n §1.2), the notification channels
 *            (api/04-push §5), the clock/location ports, the gate + every screen — and, since task
 *            50, THE DATA LAYER: the SQLCipher key, the encrypted DB, the client migrations, module
 *            registration, and a `SyncState` READ FROM THE DATABASE.
 *   ABSENT:  the sync LOOP does not run, because nothing enrolls. `App`'s `onEnroll`/`onLogin` are
 *            inert (see below), so no device ever obtains a deviceId or a device token, so there is
 *            nothing to sync with. The transport and the trigger adapters are BUILT
 *            (`transport.ts`, `triggers.ts`) and tested; what is missing is NOT just enrollment but
 *            the sync-loop WIRING itself — the `SyncLoop` construction and `BundleRefreshPort`
 *            producer that tasks 88/89 add. Sync is unwired, not merely waiting on data. What is missing is the enrollment flow that
 *            would give them a device to speak for. Filed, not faked.
 *
 * ── THE GATE IS STILL A GATE (task 24's property — do not break it) ────────────────────────────
 * `resolveZone` is a pure function of device status + session + lock, recomputed on every render,
 * "so an idle lock can't strand a screen behind a stale route". The bootstrap below does NOT touch
 * that: it resolves BEFORE any zone renders (this component returns `null` until it has), and it
 * feeds the gate's inputs rather than bypassing them. There is no path here that renders a zone
 * before the device-status check, because there is no path here that renders anything before
 * `App` — which asks `resolveZone` first, unconditionally.
 *
 * ── WHY `device` IS STILL `unenrolled`, AND WHY THAT IS NOT A STUB ─────────────────────────────
 * 10-db §9 says `meta_kv` holds `'deviceId','tenantId','storeId'`. `applyBundle` writes `tenantId`;
 * NOTHING writes `deviceId` or `storeId` — task 14's enrollment persists a draft and DELETES it on
 * completion. So "is this device enrolled?" has no stored answer to read. `unenrolled` is therefore
 * the TRUE state of every device this code can produce, not a placeholder: no device can enroll, so
 * no device is enrolled. The moment enrollment persists an id, this reads it. Filed.
 */
import { useEffect, useState } from 'react';

import App from '../../App.js';
import { bootstrapI18n, type LocaleStorePort } from '../i18n.js';
import { defaultMuteState, type DeviceInfo } from '../screens/settings/model.js';
import type { SyncStatusInput } from '../screens/sync-status/model.js';
import { systemClock } from '../ports/clock.js';
import { startLocationWatcher } from '../ports/location.js';
import type { Locale } from '@bolusi/i18n';
import type { SyncState } from '@bolusi/core';

import type { Bootstrapped } from './bootstrap.js';
import { createNotificationChannels } from './notifications.js';

/**
 * The Sync Status screen's input, built from the device's REAL `SyncState`.
 *
 * THE ONE LINE THAT MATTERS: `state` is the record `bootstrap()` read out of `sync_state` — not a
 * literal. Task 24 passed `lastSuccessfulSyncAt: null` and was right to ("not a convenient
 * placeholder but the TRUE state of a device with no sync client"), but it was right as an
 * ASSERTION. Now it is a READ: a fresh device shows `stale` because the column IS null, and a
 * synced device will show its real freshness without this file changing.
 *
 * There is deliberately no `?? Date.now()` and no `?? 0` on this path (T-19). A default on a value
 * we failed to read manufactures a plausible answer, and the plausible answer here is "your data is
 * fresh" — the one lie this product must never tell (design-system §4 rule 5).
 */
function syncInput(state: SyncState, now: number): SyncStatusInput {
  return {
    state,
    // 03 §10: the loop's state is in-memory, one instance per app process. There IS no loop (see
    // the header), and `idle` is the honest reading of that — nothing is pushing or pulling. It is
    // not a claim that sync is healthy: `staleness` answers that, from `state`, and says `stale`.
    loopState: 'idle',
    // 01 §5.2: derived queries, never stored. They are `0` here because nothing appends yet — no
    // command runs without a session, and no session exists without enrollment. `pendingOperationCount`
    // (core) is what reads them the moment there is something to count.
    pendingOperationCount: 0,
    pendingMediaCount: 0,
    rejected: [],
    quarantined: [],
    media: [],
    // No connectivity signal exists: NetInfo is not installed and is not in 08 §2.2's table, so
    // trigger (a) is absent (see triggers.ts). `true` is the true state rather than a guess — this
    // device has never reached a server and cannot, so reporting "online" would be the cheerful
    // fake. It renders the NEUTRAL grey chip (design-system §4 rule 6: offline is a normal
    // operating mode, not an error), which is exactly what a device with no sync client is.
    isOffline: true,
    manualSyncBusy: false,
    manualSyncError: null,
    now,
  };
}

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
}

export function Root({ localeStore, deviceInfo, boot }: RootProps): React.JSX.Element | null {
  const [locale, setLocale] = useState<Locale | null>(null);
  const [app, setApp] = useState<Bootstrapped | null>(null);

  useEffect(() => {
    void (async () => {
      // Order matters (08 §6.3). i18n FIRST, because the notification channels' NAMES are catalog
      // strings and Android keeps whatever name it is first given.
      const booted = await bootstrapI18n(localeStore);
      setLocale(booted);
      await createNotificationChannels(defaultMuteState());
      await startLocationWatcher();

      // The data layer. Deliberately NOT wrapped in a try/catch that renders the shell anyway: a
      // failure here (missing SQLCipher key, failed migration, module-registration defect) means
      // the app has no database, and booting the screens over that would be the working-looking
      // shape this whole task exists to refuse — every screen would render, and nothing would
      // persist. 02 §3.2 says a registration defect is a "startup failure (not a warning)"; an
      // unhandled rejection here is loud, and loud is correct until there is a real error surface
      // to route it to (owed to 27a's bootstrap report).
      setApp(await boot());
    })();
  }, [localeStore, boot]);

  // Render nothing until the locale is resolved AND the data layer is up. One frame of the wrong
  // language on the enrollment screen is the first thing this shop would see every morning
  // (07-i18n §1.2) — and a frame of the shell over a database that is not open is the other thing
  // worth never showing.
  if (locale === null || app === null) return null;

  return (
    <App
      device="unenrolled"
      users={null}
      usersError={null}
      pinRow={() => null}
      now={systemClock.now()}
      session={null}
      locked={false}
      sync={syncInput(app.syncState, systemClock.now())}
      onSyncNow={() => undefined}
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
