// Scope validation (05 §9, api/02-auth §6.3). Fail closed — accept only if every rule holds.
// SCOPE_VIOLATION is the single code for the whole set (05 §8 gains no new code); the `reason`
// distinguishes them for the anomaly detail + operator debugging.
//
// Device binding is checked SEPARATELY and EARLIER by the orchestrator (before signature) so an
// op signed by its real device but pushed via another device's token attributes as SCOPE_VIOLATION
// rather than BAD_SIGNATURE. This module carries the rest: tenant/store/user consistency,
// membership-not-status, and the per-type extension rules.
import type { TenantDb } from '@bolusi/db-server';
import type { SignedOperation } from '@bolusi/schemas';

import type { DeviceRecord } from '../types.js';

/** The per-type extension list (05 §9.5) — spec-fixed op-type + permission-id strings. */
export const GENESIS_TYPE = 'auth.device_enrolled';
export const AUTH_PIN_CHANGED = 'auth.pin_changed';
export const AUTH_PIN_RESET = 'auth.pin_reset';
export const AUTH_PIN_LOCKOUT_CLEARED = 'auth.pin_lockout_cleared';
export const PLATFORM_CONFLICT_DETECTED = 'platform.conflict_detected';
export const PLATFORM_CONFLICT_ACKNOWLEDGED = 'platform.conflict_acknowledged';

export const PERM_USER_RESET_PIN = 'auth.user_reset_pin';
export const PERM_PIN_UNLOCK = 'auth.pin_unlock';
/** The tenant-administration role a pin_reset target may hold (api/02-auth §6.6). */
export const MAIN_OWNER_ROLE = 'main_owner';

export type ScopeOutcome = null | { readonly reason: string };

async function actorHoldsPermission(
  db: TenantDb,
  userId: string,
  permissionId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('userRoles')
    .innerJoin('rolePermissions', 'rolePermissions.roleId', 'userRoles.roleId')
    .select('rolePermissions.permissionId')
    .where('userRoles.userId', '=', userId)
    .where('rolePermissions.permissionId', '=', permissionId)
    .executeTakeFirst();
  return row !== undefined;
}

async function userHoldsRole(db: TenantDb, userId: string, roleName: string): Promise<boolean> {
  const row = await db
    .selectFrom('userRoles')
    .innerJoin('roles', 'roles.id', 'userRoles.roleId')
    .select('roles.id')
    .where('userRoles.userId', '=', userId)
    .where('roles.name', '=', roleName)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Validate scope for a chain-valid, signature-valid op. All queries run under RLS (tenant-bound
 * handle), so a store/user id belonging to another tenant is simply invisible → not found →
 * SCOPE_VIOLATION.
 */
export async function checkScope(
  db: TenantDb,
  op: SignedOperation,
  device: DeviceRecord,
): Promise<ScopeOutcome> {
  // §9.2: op tenant == device tenant.
  if (op.tenantId !== device.tenantId) {
    return { reason: 'op tenantId does not match the device tenant' };
  }

  // §9.2: op store is null (tenant-scoped) or a store of the tenant.
  if (op.storeId !== null) {
    const store = await db
      .selectFrom('stores')
      .select('id')
      .where('id', '=', op.storeId)
      .executeTakeFirst();
    if (store === undefined) return { reason: 'op storeId is not a store of the tenant' };
  }

  // §9.3: op userId is a MEMBER of the tenant directory — membership, NOT active status. Ops from
  // users deactivated while the device was offline are accepted (the audit trail wants them).
  const user = await db
    .selectFrom('users')
    .select('id')
    .where('id', '=', op.userId)
    .executeTakeFirst();
  if (user === undefined) return { reason: 'op userId is not a member of the tenant directory' };

  // §9.5 per-type extension rules.
  switch (op.type) {
    case GENESIS_TYPE:
      // Genesis structural: seq 1, entityId == the device's own id.
      if (op.seq !== 1 || op.entityId !== op.deviceId) {
        return {
          reason: 'auth.device_enrolled must be the device genesis (seq 1, entityId = deviceId)',
        };
      }
      return null;

    case AUTH_PIN_CHANGED:
      // Self only: envelope userId == entityId (target).
      if (op.userId !== op.entityId) {
        return { reason: 'auth.pin_changed may only target the acting user (userId == entityId)' };
      }
      return null;

    case AUTH_PIN_RESET: {
      // Actor must hold auth.user_reset_pin; and if the TARGET holds main_owner, the actor must
      // too (blocks store_owner → main_owner impersonation, api/02-auth §6.6).
      if (!(await actorHoldsPermission(db, op.userId, PERM_USER_RESET_PIN))) {
        return { reason: 'auth.pin_reset requires the actor to hold auth.user_reset_pin' };
      }
      const targetIsMainOwner = await userHoldsRole(db, op.entityId, MAIN_OWNER_ROLE);
      if (targetIsMainOwner && !(await userHoldsRole(db, op.userId, MAIN_OWNER_ROLE))) {
        return { reason: 'resetting a main_owner PIN requires the actor to hold main_owner' };
      }
      return null;
    }

    case AUTH_PIN_LOCKOUT_CLEARED:
      if (!(await actorHoldsPermission(db, op.userId, PERM_PIN_UNLOCK))) {
        return { reason: 'auth.pin_lockout_cleared requires the actor to hold auth.pin_unlock' };
      }
      return null;

    case PLATFORM_CONFLICT_DETECTED:
      // Only a tenant SYSTEM device may emit conflict_detected; it is server-built (appendSystemOp),
      // never pushed by a member device.
      if (device.kind !== 'system') {
        return {
          reason: 'platform.conflict_detected may only originate from the tenant system device',
        };
      }
      return null;

    case PLATFORM_CONFLICT_ACKNOWLEDGED:
      // Member devices acknowledge; no extra structural rule here (permission is command-side).
      return null;

    default:
      return null;
  }
}
