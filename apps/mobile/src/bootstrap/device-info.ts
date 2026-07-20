// The Settings device-info block, DERIVED FROM PERSISTED STATE (task 94; api/02-auth §4.3).
//
// The four fields a shop reads to an owner over the phone during a revocation — deviceId, deviceName,
// store and tenant — ARE the device's identity, and the Settings screen must show the REAL ones. Until
// this file, `index.ts` handed `Root` a hardcoded empty `deviceInfo`, so a device that now enrolls
// (task 92) rendered every field BLANK — the exact working-looking lie the codebase refuses.
//
// ── WHERE EACH FIELD LIVES AFTER ENROLLMENT ─────────────────────────────────────────────────────
//   deviceId:  meta_kv (task 88 / core's DEVICE_ID_META_KEY), written by `runEnrollment`.
//   storeName / tenantName: NOT in any directory table (the mirrors carry user + role names only,
//     10-db §9.5). They ride EVERY bundle (`bundle.store.name`/`bundle.tenant.name`, api/02-auth §5.2),
//     and core's `applyBundle` is their SOLE writer — persisting them to meta_kv on enroll AND on every
//     pull refresh (task 109), so a store/tenant RENAME reaches the device without re-enrollment. This
//     file only READS them back (via core's STORE_NAME_META_KEY/TENANT_NAME_META_KEY).
//   deviceName: what the owner typed in the wizard — the owner-typed genesis value, NOT on the bundle.
//     The enrollment caller (enrollment.ts) persists it to meta_kv at enroll (`persistEnrolledNames`);
//     this reads it back. ONE writer for deviceName (here), one for the two names (core) — never two
//     writers of one key that could disagree (§2.8).
//   platform / appVersion: process facts, not DB values — supplied by the one native-binding site
//     (index.ts). appVersion is `''` in v0 (expo-constants unpinned — decisions/2026-07-20-appversion-source).
import {
  readDeviceId,
  readMeta,
  STORE_NAME_META_KEY,
  TENANT_NAME_META_KEY,
  writeMeta,
} from '@bolusi/core';

import type { DeviceInfo } from '../screens/settings/model.js';

import type { Bootstrapped } from './bootstrap.js';

/**
 * meta_kv key holding the owner-typed device name (task 94). Named under `auth.` like the enrollment
 * draft key, distinct from core's id keys (`deviceId`/`storeId`). The store/tenant name keys live in
 * `@bolusi/core` (STORE_NAME_META_KEY/TENANT_NAME_META_KEY, imported above) because core's
 * `applyBundle` is their single writer (task 109) — one definition of each key string, no drift (§2.8).
 */
export const DEVICE_NAME_META_KEY = 'auth.deviceName';

/** The process facts index.ts binds — the RN platform and the app version string (not DB values). */
export interface DeviceInfoContext {
  readonly platform: 'android' | 'ios';
  readonly appVersion: string;
}

/** The owner-typed device name, persisted at enroll so a later boot can render it (task 94). The
 *  store/tenant names are NOT here — core's `applyBundle` owns them on every bundle (task 109). */
export interface EnrolledNames {
  readonly deviceName: string;
}

/**
 * Persist the owner-typed device name to meta_kv (task 94). The enrollment caller calls this AFTER
 * `runEnrollment` — which persisted the ids AND ran `applyBundle`, so the store/tenant names are
 * already fresh in meta_kv (task 109) — and BEFORE it signals `onEnrolled`, so the live re-derive and
 * every later boot read a full identity. Only `deviceName` is written here: it is the sole key this
 * file owns; the store/tenant names have exactly one writer (core), never two that could disagree (§2.8).
 */
export async function persistEnrolledNames(app: Bootstrapped, names: EnrolledNames): Promise<void> {
  await writeMeta(app.db.db, DEVICE_NAME_META_KEY, names.deviceName);
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
