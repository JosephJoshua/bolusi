// The Settings DEVICE-INFO block renders its data, not blanks (design-system §8.x; task 94), and the
// NOTIFICATION rows hand off to the OS notification settings (api/04-push §5; D18 §1; task 59).
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────────
// The device block is what a shop reads to an owner over the phone during a revocation (model.ts §3):
// device name, id, store, tenant. Until task 94 index.ts handed a hardcoded EMPTY deviceInfo, so a
// device that now enrolls (task 92) rendered every field blank. The reader that fixes it lives in
// bootstrap/device-info.ts and is proven over a real DB in device-info.test.ts; THIS file proves the
// other half — that the screen actually paints whatever DeviceInfo it is given onto the three rows.
//
// FALSIFIED (§2.11): hardcoding any device row's `primaryText`/`secondaryText` back to a literal (or
// blank) turns the "renders the identity" test RED; the blank control below is the positive control
// (T-14b) that keeps the first test honest — it proves the green comes from the DATA, not from a
// screen that happens to print "Kasir 1" unconditionally. The notification-row test is falsified the
// same way: point the row's onPress at a no-op and the "hands off to the deep-link" test reds.
//
// The values asserted are runtime DATA (a device id, an owner-typed name, server-supplied store /
// tenant names), NOT translatable copy — so reading them back is the never-blank check itself, not
// the label-echo assertion testing-guide T-4 forbids.
import { fire, render, textsIn } from '../../../../../packages/ui/test/render.js';
import { describe, expect, test, vi } from 'vitest';

import { SettingsScreen } from './SettingsScreen.js';
import { MUTABLE_PUSH_CATEGORIES, type DeviceInfo, type MutablePushCategory } from './model.js';

const ENROLLED: DeviceInfo = {
  deviceId: 'device-abc-123',
  deviceName: 'Kasir 1',
  storeName: 'Toko Jayapura',
  tenantName: 'Bolusi Papua',
  platform: 'android',
  appVersion: '',
};

const BLANK: DeviceInfo = {
  deviceId: '',
  deviceName: '',
  storeName: '',
  tenantName: '',
  platform: 'android',
  appVersion: '',
};

function renderSettings(
  device: DeviceInfo,
  onOpenNotificationSettings: (category: MutablePushCategory) => void = vi.fn(),
) {
  return render(
    <SettingsScreen
      locale="id"
      onSelectLocale={vi.fn()}
      onOpenNotificationSettings={onOpenNotificationSettings}
      device={device}
      currentUser={{ id: 'user-1', initials: 'PO' }}
      onBack={vi.fn()}
      onOpenSwitcher={vi.fn()}
      syncChip="synced"
      onOpenSync={vi.fn()}
    />,
  );
}

/** The visible text of a row's primary/secondary line. `join('')` collapses the empty-child case. */
function lineText(screen: ReturnType<typeof renderSettings>, testID: string): string {
  return textsIn(screen.get(testID)).join('');
}

describe('the device-info block renders the enrolled identity (task 94)', () => {
  test('deviceName + deviceId, storeName + tenantName, and the platform all paint from the prop', () => {
    const screen = renderSettings(ENROLLED);

    expect(lineText(screen, 'settings-device-id.primary')).toBe('Kasir 1');
    expect(lineText(screen, 'settings-device-id.secondary')).toBe('device-abc-123');
    expect(lineText(screen, 'settings-device-store.primary')).toBe('Toko Jayapura');
    expect(lineText(screen, 'settings-device-store.secondary')).toBe('Bolusi Papua');
    expect(lineText(screen, 'settings-device-platform.primary')).toBe('android');
  });
});

describe('POSITIVE CONTROL: blank in ⇒ blank out (T-14b)', () => {
  test('an empty DeviceInfo renders empty rows — the screen shows its data, it does not invent it', () => {
    // Without this, the test above would still pass on a screen that printed "Kasir 1" unconditionally.
    // This proves the enrolled render is driven by the prop: hand blanks, get blanks. A blank block
    // means the device is unenrolled (the reader's honest empty state), not that the screen hardcodes.
    const screen = renderSettings(BLANK);

    expect(lineText(screen, 'settings-device-id.primary')).toBe('');
    expect(lineText(screen, 'settings-device-id.secondary')).toBe('');
    expect(lineText(screen, 'settings-device-store.primary')).toBe('');
    expect(lineText(screen, 'settings-device-store.secondary')).toBe('');
  });
});

describe('the notification rows open the OS notification settings (api/04-push §5; D18 §1; task 59)', () => {
  test('pressing a category row hands off to the deep-link for THAT category', () => {
    // v0 muting is the OS's: the row does not toggle a mute flag (Android forbids it, iOS has no
    // channels — D18 §1), it deep-links to the platform screen the user owns. The screen's whole job
    // here is to route the press to `onOpenNotificationSettings(category)`.
    const onOpenNotificationSettings = vi.fn();
    const screen = renderSettings(ENROLLED, onOpenNotificationSettings);

    fire(screen.get('settings-notifications-conflict'), 'onPress');
    expect(onOpenNotificationSettings).toHaveBeenCalledTimes(1);
    expect(onOpenNotificationSettings).toHaveBeenLastCalledWith('conflict');

    fire(screen.get('settings-notifications-device'), 'onPress');
    expect(onOpenNotificationSettings).toHaveBeenCalledTimes(2);
    expect(onOpenNotificationSettings).toHaveBeenLastCalledWith('device');
  });

  test('one row per VISIBLE category, and none for `sync` (§3: data-only, no channel)', () => {
    const screen = renderSettings(ENROLLED);

    for (const category of MUTABLE_PUSH_CATEGORIES) {
      expect(screen.query(`settings-notifications-${category}`)).not.toBeNull();
    }
    expect(screen.query('settings-notifications-sync')).toBeNull();
  });
});
