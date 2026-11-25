// "Perangkat": this phone first and never blockable here, a block only after the confirmation that
// names the last sync, the list re-read from the server after it, and a refusal said in words.
import { StaffAdminError } from '@bolusi/core';
import type { DeviceList, DeviceRow } from '@bolusi/device/models/devices/model';
import { t } from '@bolusi/i18n';
import { act } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { fire, render, textsIn } from '../../../../../packages/ui/test/render.js';

import { DevicesScreen } from './DevicesScreen.js';

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

function row(overrides: Partial<DeviceRow> & { id: string }): DeviceRow {
  return {
    name: overrides.id,
    detail: 'Perangkat toko · disinkronkan 5 menit lalu',
    isThis: false,
    blocked: false,
    lastSyncAt: Date.UTC(2026, 10, 25, 9, 0),
    ...overrides,
  };
}

const LIST: DeviceList = {
  active: [
    row({ id: 'd-this', name: 'HP Kasir', isThis: true }),
    row({ id: 'd-ani', name: 'HP Ani' }),
  ],
  blocked: [row({ id: 'd-old', name: 'HP Lama', blocked: true, detail: 'Perangkat toko' })],
};

async function mount(
  load: () => Promise<DeviceList>,
  onBlock: (deviceId: string) => Promise<void> = () => Promise.resolve(),
) {
  const onClose = vi.fn();
  const screen = render(<DevicesScreen load={load} onBlock={onBlock} onClose={onClose} />);
  await flush();
  return { screen, onClose, press: (testID: string) => fire(screen.get(testID), 'onPress') };
}

describe('DevicesScreen', () => {
  test('lists this phone first without a block, the others with one, the blocked apart', async () => {
    const { screen } = await mount(() => Promise.resolve(LIST));
    expect(screen.query('devices-block-d-this')).toBeNull();
    expect(screen.query('devices-block-d-ani')).not.toBeNull();
    expect(screen.query('devices-block-d-old')).toBeNull();
    expect(textsIn(screen.get('devices-screen'))).toContain(t('auth.devices.blockedSection'));
    expect(screen.query('devices-alone')).toBeNull();
  });

  test('blocks only after the confirmation, then re-reads the list and says so', async () => {
    const load = vi.fn(() => Promise.resolve(LIST));
    const onBlock = vi.fn(() => Promise.resolve());
    const { screen, press } = await mount(load, onBlock);

    press('devices-block-d-ani');
    expect(onBlock).not.toHaveBeenCalled();
    const sheet = textsIn(screen.get('devices-confirm'));
    expect(sheet).toContain(t('auth.devices.blockTitle', { name: 'HP Ani' }));
    expect(sheet.join(' ')).toMatch(/belum terkirim/);

    press('devices-confirm.confirm');
    await flush();
    expect(onBlock).toHaveBeenCalledWith('d-ani');
    expect(load).toHaveBeenCalledTimes(2);
    expect(textsIn(screen.get('devices-notice'))).toContain(
      t('auth.devices.blocked', { name: 'HP Ani' }),
    );
  });

  test('cancelling the confirmation sends nothing', async () => {
    const onBlock = vi.fn(() => Promise.resolve());
    const { screen, press } = await mount(() => Promise.resolve(LIST), onBlock);
    press('devices-block-d-ani');
    press('devices-confirm.cancel');
    expect(screen.query('devices-confirm')).toBeNull();
    expect(onBlock).not.toHaveBeenCalled();
  });

  test('a refused block keeps the list and says why', async () => {
    const onBlock = vi.fn(() => Promise.reject(new StaffAdminError('offline')));
    const { screen, press } = await mount(() => Promise.resolve(LIST), onBlock);
    press('devices-block-d-ani');
    press('devices-confirm.confirm');
    await flush();
    expect(textsIn(screen.get('devices-notice'))).toContain(t('auth.devices.failure.offline'));
    expect(screen.query('devices-row-d-ani')).not.toBeNull();
  });

  test('offline at open says it needs the internet, and retry loads again', async () => {
    const load = vi
      .fn<() => Promise<DeviceList>>()
      .mockRejectedValueOnce(new StaffAdminError('offline'))
      .mockResolvedValue(LIST);
    const { screen } = await mount(load);
    expect(textsIn(screen.get('devices-screen'))).toContain(t('auth.devices.failure.offline'));
    fire(screen.all('ui.errorState.retry')[0]!, 'onPress');
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.query('devices-row-d-ani')).not.toBeNull();
  });

  test('the only device here gets a hint that others will appear', async () => {
    const { screen } = await mount(() =>
      Promise.resolve({ active: [row({ id: 'd-this', isThis: true })], blocked: [] }),
    );
    expect(textsIn(screen.get('devices-alone'))).toEqual([
      t('auth.devices.empty'),
      t('auth.devices.emptyBody'),
    ]);
  });
});
