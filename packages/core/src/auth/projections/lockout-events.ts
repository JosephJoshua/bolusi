// The `pin_lockout_events` projection (api/02-auth §6.2/§6.5). Append-only, owner-visible
// brute-force evidence: one row per `auth.pin_locked_out` (a user hit the 10th consecutive failure)
// and per `auth.pin_lockout_cleared` (an owner unlocked them, or a reset cleared the lock).
//
// APPEND-ONLY, KEYED BY THE OP ID. Each op is its OWN row (`id` = op id), because these are events
// on a timeline, not a mutable state — the current lock STATE lives in the local `pin_attempt_state`
// table (10-db §9.5), which the auth runtime maintains (lockout.ts), NOT here. This projection is
// the synced audit history the owner reads back.
//
// THE ENTITY IS THE USER'S CREDENTIAL, NOT THE EVENT. `entityType: 'user_credential'` /
// `entityId: userId` — the SAME entity `auth.pin_changed` / `auth.pin_reset` carry (which do not
// project here). So the §4.2 re-fold of one user's credential deletes THIS user's lockout events by
// `user_id` and replays the full credential history in canonical order; the pin-change/reset ops
// fold as no-ops (module.ts), the lockout ops re-insert. Every event is reconstructed, none twice.
import type { ProjectionApplier, ProjectionTableManifest } from '../../projection/manifest.js';
import { AUTH_ENTITY } from '../operations.js';
import type { AuthDatabase, PinLockoutEventsTable } from '../schema.js';

/** `auth.pin_locked_out` payload (api/02-auth §6.2/§6.5). */
export interface PinLockedOutPayload {
  readonly consecutiveFailures: number;
  readonly windowStartedAt: number;
}

/** The two event kinds this table records (10-db §549+ CHECK). */
export const LOCKOUT_KIND = {
  lockedOut: 'pin_locked_out',
  lockoutCleared: 'pin_lockout_cleared',
} as const;

/**
 * 04 §4.4 table manifest — columns in 10-db §549+ DDL order (the oracle's digest order).
 *
 * `entityIdColumn: 'user_id'`, NOT the `id` primary key: the re-fold (§4.2) deletes a user's events
 * by the TARGETED user (`entityId`), and `user_id` is the column holding it. `id` holds the op id,
 * which is unique per row and would delete nothing on a re-fold — the exact `entityIdColumn` trap
 * `define-module` guards against. Two columns, two distinct jobs.
 */
export const pinLockoutEventsTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    user_id: 'text',
    device_id: 'text',
    kind: 'text',
    failure_count: 'integer',
    at: 'integer',
  },
  primaryKey: ['id'],
  entityType: AUTH_ENTITY.userCredential,
  entityIdColumn: 'user_id',
  projectionVersion: 1,
};

/**
 * Fold `auth.pin_locked_out` → one `pin_lockout_events` row.
 *
 * `user_id` is the op's `entityId` (the TARGETED user), not the envelope `userId` — for this op type
 * they are the same (api/02-auth §6.3: the 10th-failure emission carries `userId` = the targeted
 * user), but keying off `entityId` states the invariant the re-fold delete relies on rather than a
 * coincidence. `failure_count` carries the signed `consecutiveFailures`; `device_id` is the envelope
 * device the lockout happened on.
 */
export const pinLockedOutApplier: ProjectionApplier<AuthDatabase> = async (db, op) => {
  const payload = op.payload as unknown as PinLockedOutPayload;
  const row: PinLockoutEventsTable = {
    id: op.id,
    tenantId: op.tenantId,
    storeId: op.storeId,
    userId: op.entityId,
    deviceId: op.deviceId,
    kind: LOCKOUT_KIND.lockedOut,
    failureCount: payload.consecutiveFailures,
    at: op.timestamp,
  };
  await db.insertInto('pinLockoutEvents').values(row).execute();
};

/**
 * Fold `auth.pin_lockout_cleared` → one `pin_lockout_events` row (`failure_count` NULL — a clear has
 * no failure count, 10-db §549+). Payload is `{}` (api/02-auth §6.2). `user_id` is the op's
 * `entityId` (the targeted user whose lock was cleared); `device_id` is the device the clearing
 * owner acted on.
 */
export const pinLockoutClearedApplier: ProjectionApplier<AuthDatabase> = async (db, op) => {
  const row: PinLockoutEventsTable = {
    id: op.id,
    tenantId: op.tenantId,
    storeId: op.storeId,
    userId: op.entityId,
    deviceId: op.deviceId,
    kind: LOCKOUT_KIND.lockoutCleared,
    failureCount: null,
    at: op.timestamp,
  };
  await db.insertInto('pinLockoutEvents').values(row).execute();
};
