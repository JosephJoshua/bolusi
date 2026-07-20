// The Settings device-info block, DERIVED FROM PERSISTED STATE (task 94; api/02-auth §4.3).
//
// The four fields a shop reads to an owner over the phone during a revocation — deviceId, deviceName,
// store and tenant — ARE the device's identity, and the Settings screen must show the REAL ones. Until
// this file, `index.ts` handed `Root` a hardcoded empty `deviceInfo`, so a device that now enrolls
// (task 92) rendered every field BLANK — the exact working-looking lie the codebase refuses.
//
// ── WHERE EACH FIELD LIVES AFTER ENROLLMENT ─────────────────────────────────────────────────────
//   deviceId:  meta_kv (task 88 / core's DEVICE_ID_META_KEY), written by `runEnrollment`.
//   deviceName / storeName / tenantName: NOT in any directory table. The directory mirrors carry
//     user + role names only (10-db §9.5), and the store/tenant NAMES arrive only in the transient
//     enroll RESPONSE (api/02-auth §4.3) — gone by the next boot. So the enrollment caller
//     (enrollment.ts) persists them to meta_kv at enroll time (`persistEnrolledNames`), and this reads
//     them back on every boot. deviceName is what the owner typed in the wizard; the store/tenant names
//     are the response's.
//   platform / appVersion: process facts, not DB values — supplied by the one native-binding site
//     (index.ts). appVersion is `''` in v0 (expo-constants unpinned — decisions/2026-07-20-appversion-source).
//
// ── KNOWN LIMITATION (out of this task's apps/mobile-only scope) ─────────────────────────────────
// The store/tenant NAMES ideally belong in core's `applyBundle` (it already holds `bundle.store.name`
// / `bundle.tenant.name`), so a bundle refresh keeps them fresh. Persisting them from mobile means a
// tenant/store RENAME without re-enrollment leaves these two names stale (the ids and deviceName do
// not drift). The deviceId — the stable revocation key — is always exact. Filed as a follow-up note.
import { readDeviceId, readMeta, writeMeta } from '@bolusi/core';

import type { DeviceInfo } from '../screens/settings/model.js';

import type { Bootstrapped } from './bootstrap.js';

/**
 * meta_kv keys holding the human-readable identity the enroll response establishes (task 94). Named
 * under `auth.` like the enrollment draft key, distinct from core's id keys (`deviceId`/`storeId`).
 */
export const DEVICE_NAME_META_KEY = 'auth.deviceName';
export const STORE_NAME_META_KEY = 'auth.storeName';
export const TENANT_NAME_META_KEY = 'auth.tenantName';

/** The process facts index.ts binds — the RN platform and the app version string (not DB values). */
export interface DeviceInfoContext {
  readonly platform: 'android' | 'ios';
  readonly appVersion: string;
}

/** The names the enroll response establishes, persisted at enroll so a later boot can render them. */
export interface EnrolledNames {
  readonly deviceName: string;
  readonly storeName: string;
  readonly tenantName: string;
}

/**
 * Persist the enrolled device's human-readable identity to meta_kv (task 94). The enrollment caller
 * calls this AFTER `runEnrollment` (which persisted the ids) and BEFORE it signals `onEnrolled`, so
 * both the live re-derive and every later boot read the same values.
 */
export async function persistEnrolledNames(app: Bootstrapped, names: EnrolledNames): Promise<void> {
  await writeMeta(app.db.db, DEVICE_NAME_META_KEY, names.deviceName);
  await writeMeta(app.db.db, STORE_NAME_META_KEY, names.storeName);
  await writeMeta(app.db.db, TENANT_NAME_META_KEY, names.tenantName);
}

/**
 * Read the Settings device-info block from persisted state.
 *
 * An UNENROLLED device (`deviceId` null in meta_kv) returns the empty block: there is no
 * server-established identity to show, and the enrollment wizard — not the settings device rows —
 * renders on this device. That empty is a deliberate branch, NOT a `?? ''` masking an enrolled
 * device's missing field (the acceptance's distinction).
 *
 * An ENROLLED device returns its real identity. The wizard requires a non-empty `deviceName` and the
 * server supplies the store + tenant names, so on the settled path all four are present; the only way
 * a name read is null here is the sub-millisecond crash window between `runEnrollment`'s id-persist
 * and `persistEnrolledNames` — surfaced as empty, never a fabricated plausible value (T-19).
 */
export async function readDeviceInfo(
  app: Bootstrapped,
  ctx: DeviceInfoContext,
): Promise<DeviceInfo> {
  const deviceId = await readDeviceId(app.db.db);
  if (deviceId === null) {
    return {
      deviceId: '',
      deviceName: '',
      storeName: '',
      tenantName: '',
      platform: ctx.platform,
      appVersion: ctx.appVersion,
    };
  }

  const [deviceName, storeName, tenantName] = await Promise.all([
    readMeta(app.db.db, DEVICE_NAME_META_KEY),
    readMeta(app.db.db, STORE_NAME_META_KEY),
    readMeta(app.db.db, TENANT_NAME_META_KEY),
  ]);
  return {
    deviceId,
    deviceName: deviceName ?? '',
    storeName: storeName ?? '',
    tenantName: tenantName ?? '',
    platform: ctx.platform,
    appVersion: ctx.appVersion,
  };
}
