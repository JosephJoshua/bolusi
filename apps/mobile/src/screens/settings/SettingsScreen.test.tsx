// The Settings DEVICE-INFO block renders its data, not blanks (design-system §8.x; task 94).
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
// screen that happens to print "Kasir 1" unconditionally.
//
// The values asserted are runtime DATA (a device id, an owner-typed name, server-supplied store /
// tenant names), NOT translatable copy — so reading them back is the never-blank check itself, not
// the label-echo assertion testing-guide T-4 forbids.
import { render, textsIn } from '../../../../../packages/ui/test/render.js';
import { describe, expect, test, vi } from 'vitest';

import { SettingsScreen } from './SettingsScreen.js';
import { defaultMuteState, type DeviceInfo } from './model.js';

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

function renderSettings(device: DeviceInfo) {
  return render(
    <SettingsScreen
      locale="id"
      onSelectLocale={vi.fn()}
      muted={defaultMuteState()}
      onToggleMute={vi.fn()}
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
