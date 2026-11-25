// "Perangkat" (owner decision 2026-11-25): the store's phones and PCs, and blocking a lost one. Both
// apps render these rows; the wording and order live here once.
import type { RegisteredDevice, StaffAdminFailure } from '@bolusi/core';
import { formatDateTime, formatRelative, t } from '@bolusi/i18n';

/** One device as the list shows it. */
export interface DeviceRow {
  readonly id: string;
  /** Its name, or a stand-in for a device registered before names existed. */
  readonly name: string;
  /** "HP pribadi Ani" or "Perangkat toko", and when it last synced or was blocked. */
  readonly detail: string;
  /** The device this list is open on: it cannot block itself from here. */
  readonly isThis: boolean;
  readonly blocked: boolean;
  readonly lastSyncAt: number | null;
}

export interface DeviceList {
  readonly active: readonly DeviceRow[];
  readonly blocked: readonly DeviceRow[];
}

export interface DeviceListContext {
  readonly storeId: string;
  readonly thisDeviceId: string;
  /** Names of the store's people, for the phones set up as someone's own. */
  readonly names: ReadonlyMap<string, string>;
  readonly now: number;
}

/**
 * This store's devices: in use (this one first, then by name) and blocked (latest first). Other
 * stores' devices are left out, as "Karyawan" shows this store's people.
 */
export function deviceList(
  devices: readonly RegisteredDevice[],
  context: DeviceListContext,
): DeviceList {
  const here = devices.filter((device) => device.storeId === context.storeId);
  const rows = here.map((device) => toRow(device, context));
  const byName = (a: DeviceRow, b: DeviceRow): number =>
    a.isThis !== b.isThis ? (a.isThis ? -1 : 1) : a.name.localeCompare(b.name);
  const blockedAt = new Map(here.map((device) => [device.id, device.blockedAt ?? 0]));
  return {
    active: rows.filter((row) => !row.blocked).sort(byName),
    blocked: rows
      .filter((row) => row.blocked)
      .sort((a, b) => (blockedAt.get(b.id) ?? 0) - (blockedAt.get(a.id) ?? 0)),
  };
}

function toRow(device: RegisteredDevice, context: DeviceListContext): DeviceRow {
  const owner =
    device.personalUserId === null ? null : (context.names.get(device.personalUserId) ?? null);
  const whose =
    device.personalUserId === null
      ? t('auth.devices.shared')
      : owner === null
        ? t('auth.devices.personalUnknown')
        : t('auth.devices.personal', { name: owner });
  const when = device.blocked
    ? device.blockedAt === null
      ? null
      : t('auth.devices.blockedAt', { time: formatDateTime(device.blockedAt) })
    : device.lastSyncAt === null
      ? t('auth.devices.neverSynced')
      : t('auth.devices.lastSync', { time: formatRelative(context.now - device.lastSyncAt) });
  return {
    id: device.id,
    name:
      device.name === null || device.name.trim() === '' ? t('auth.devices.unnamed') : device.name,
    detail: when === null ? whose : `${whose} · ${when}`,
    isThis: device.id === context.thisDeviceId,
    blocked: device.blocked,
    lastSyncAt: device.lastSyncAt,
  };
}

/** The confirmation's consequence line: when it last synced, and that the rest is erased. */
export function blockConsequence(row: DeviceRow): string {
  return row.lastSyncAt === null
    ? t('auth.devices.blockBodyNever')
    : t('auth.devices.blockBody', { time: formatDateTime(row.lastSyncAt) });
}

/** Why loading or blocking failed, in the owner's words. */
export function devicesFailureMessage(reason: StaffAdminFailure): string {
  return t(
    reason === 'offline'
      ? 'auth.devices.failure.offline'
      : reason === 'denied'
        ? 'auth.devices.failure.denied'
        : reason === 'rateLimited'
          ? 'auth.devices.failure.rateLimited'
          : 'auth.devices.failure.unexpected',
  );
}
