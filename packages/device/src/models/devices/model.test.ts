// "Perangkat": this store's devices, this one first, the rest by name, blocked ones apart (latest
// first), and the wording each row and the block confirmation carry.
import type { RegisteredDevice } from '@bolusi/core';
import { describe, expect, test } from 'vitest';

import { blockConsequence, deviceList, devicesFailureMessage } from './model.js';

const NOW = Date.UTC(2026, 10, 25, 10, 0, 0);
const MIN = 60_000;

function device(overrides: Partial<RegisteredDevice> & { id: string }): RegisteredDevice {
  return {
    name: overrides.id,
    storeId: 's-1',
    blocked: false,
    blockedAt: null,
    personalUserId: null,
    lastSyncAt: NOW - 5 * MIN,
    lastSeenAt: NOW - 5 * MIN,
    ...overrides,
  };
}

const context = {
  storeId: 's-1',
  thisDeviceId: 'd-this',
  names: new Map([['u-ani', 'Ani']]),
  now: NOW,
};

describe('deviceList', () => {
  test('keeps this store only, this device first, then by name; blocked apart, latest first', () => {
    const list = deviceList(
      [
        device({ id: 'd-z', name: 'Zebra' }),
        device({ id: 'd-other-store', storeId: 's-2' }),
        device({ id: 'd-old', name: 'Lama', blocked: true, blockedAt: NOW - 60 * MIN }),
        device({ id: 'd-this', name: 'Toko' }),
        device({ id: 'd-a', name: 'Aksa' }),
        device({ id: 'd-new', name: 'Baru', blocked: true, blockedAt: NOW - MIN }),
      ],
      context,
    );
    expect(list.active.map((row) => row.id)).toEqual(['d-this', 'd-a', 'd-z']);
    expect(list.blocked.map((row) => row.id)).toEqual(['d-new', 'd-old']);
    expect(list.active[0]?.isThis).toBe(true);
    expect(list.active[0]?.detail).toBe('Perangkat ini · disinkronkan 5 menit lalu');
    expect(list.active[1]?.isThis).toBe(false);
  });

  test('says whose phone it is and when it last synced', () => {
    const { active } = deviceList(
      [
        device({ id: 'd-a', personalUserId: 'u-ani' }),
        device({ id: 'd-b', personalUserId: 'u-gone', lastSyncAt: null }),
        device({ id: 'd-c', name: '  ' }),
      ],
      context,
    );
    const byId = new Map(active.map((row) => [row.id, row]));
    expect(byId.get('d-a')?.detail).toBe('HP pribadi Ani · disinkronkan 5 menit lalu');
    expect(byId.get('d-b')?.detail).toBe('HP pribadi · belum pernah disinkronkan');
    expect(byId.get('d-c')?.name).toBe('Tanpa nama');
    expect(byId.get('d-c')?.detail).toBe('Perangkat toko · disinkronkan 5 menit lalu');
  });

  test('a blocked device shows when it was blocked, not when it last synced', () => {
    const { blocked } = deviceList(
      [
        device({ id: 'd-x', blocked: true, blockedAt: NOW - MIN }),
        device({ id: 'd-y', blocked: true, blockedAt: null }),
      ],
      context,
    );
    const byId = new Map(blocked.map((row) => [row.id, row]));
    expect(byId.get('d-x')?.detail).toMatch(/^Perangkat toko · diblokir /);
    expect(byId.get('d-y')?.detail).toBe('Perangkat toko');
  });
});

describe('the block confirmation', () => {
  test('names the last sync and that unsent changes go too', () => {
    const [row] = deviceList([device({ id: 'd-a' })], context).active;
    expect(blockConsequence(row!)).toMatch(/^Terakhir disinkronkan .+belum terkirim\.$/);
    const [never] = deviceList([device({ id: 'd-b', lastSyncAt: null })], context).active;
    expect(blockConsequence(never!)).toBe(
      'Belum pernah disinkronkan. Saat terhubung, semua datanya dihapus.',
    );
  });

  test('every failure has its own words', () => {
    const messages = (['offline', 'denied', 'rateLimited', 'unexpected'] as const).map(
      devicesFailureMessage,
    );
    expect(new Set(messages).size).toBe(4);
  });
});
