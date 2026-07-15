/**
 * The composition root — the one place that knows about both the platform and the shell.
 *
 * `App` takes every input as a prop (so it is drivable from fakes); this file is what supplies them
 * on a real device. It is the only component `index.ts` registers.
 *
 * ── WHAT IS REAL AND WHAT IS A SEAM, STATED PLAINLY ─────────────────────────────────────────────
 * Task 24's brief scopes this file's job to the platform adapters, NOT the loop behind them, and
 * task 15 (sync-client) is not merged. So:
 *
 *   REAL here:   i18n boot at the device locale (07-i18n §1.2), the notification channels
 *                (api/04-push §5), the clock/location ports, the gate + every screen.
 *   SEAM here:   `sync` — a `SyncStatusInput` (typed against 03 §8/§10 + 01 §5.2 via
 *                `src/sync/contract.ts`, not against a guess) and `requestSync`. Task 15 supplies a
 *                real `SyncState`, the DERIVED counters, and the rejected/quarantined/media lists;
 *                the shape does not move when it does.
 *   NOT BUILT:   the DB open + local migrations, module registration, and the sync TRIGGER adapters
 *                (NetInfo / 3 s append debounce / 60 s foreground interval / background task /
 *                pull-to-refresh). Those are task 24's bootstrap item (2) and are NOT in this file —
 *                see the task file's Status note. They are deliberately absent rather than stubbed:
 *                a fake `open()` that returned a working-looking handle would let the shell boot
 *                green against a database that does not exist, which is the exact
 *                green-for-the-wrong-reason shape CLAUDE.md §2.11 exists to prevent.
 *
 * The honest consequence: this root boots the SHELL and its screens, and it does not yet boot the
 * DATA. Until the bootstrap lands, `device` resolves `unenrolled` and the app opens on the
 * enrollment wizard — which is the correct first screen for a fresh install anyway.
 */
import { useEffect, useState } from 'react';

import App from '../../App.js';
import { bootstrapI18n, type LocaleStorePort } from '../i18n.js';
import { defaultMuteState, type DeviceInfo } from '../screens/settings/model.js';
import type { SyncStatusInput } from '../screens/sync-status/model.js';
import { systemClock } from '../ports/clock.js';
import { startLocationWatcher } from '../ports/location.js';
import type { Locale } from '@bolusi/i18n';

import { createNotificationChannels } from './notifications.js';

/**
 * The task-15 seam's v0 value: a device that has never synced.
 *
 * `lastSuccessfulSyncAt: null` is NOT a placeholder chosen for convenience — it is the TRUE state of
 * a device with no sync client, and 03 §8 maps it to `stale`. So the shell honestly shows the loud
 * "you have never connected" banner rather than a cheerful fake `fresh`. A stub that claimed
 * freshness would be the one lie this product must never tell (design-system §4 rule 5), and it
 * would go unnoticed precisely because it looks like success.
 */
function neverSyncedInput(now: number): SyncStatusInput {
  return {
    state: {
      lastSuccessfulSyncAt: null,
      pushHalted: false,
      syncDisabled: false,
      syncDisabledReason: null,
      loopState: 'idle',
      lastServerTime: null,
      lastServerTimeAt: null,
    },
    pendingOperationCount: 0,
    pendingMediaCount: 0,
    rejected: [],
    quarantined: [],
    media: [],
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
}

export function Root({ localeStore, deviceInfo }: RootProps): React.JSX.Element | null {
  const [locale, setLocale] = useState<Locale | null>(null);

  useEffect(() => {
    void (async () => {
      // Order matters: i18n first, because the notification channels' NAMES are catalog strings and
      // Android keeps whatever name it is first given.
      const booted = await bootstrapI18n(localeStore);
      setLocale(booted);
      await createNotificationChannels(defaultMuteState());
      await startLocationWatcher();
    })();
  }, [localeStore]);

  // Render nothing until the locale is resolved. One frame of the wrong language on the enrollment
  // screen is the first thing this shop would see, every morning (07-i18n §1.2).
  if (locale === null) return null;

  return (
    <App
      device="unenrolled"
      users={null}
      usersError={null}
      pinRow={() => null}
      now={systemClock.now()}
      session={null}
      locked={false}
      sync={neverSyncedInput(systemClock.now())}
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
