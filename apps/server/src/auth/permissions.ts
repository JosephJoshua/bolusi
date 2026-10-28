// Server-side permission checks. The DECISION is core's `evaluatePermission`, the same pure function
// every device runs before a command (02-permissions §5.2), fed the server's own directory rows. The
// server is the authority: its directory is the truth, a device's copy is a cache of it. One function
// on both sides means a device and the server can never disagree about what a role allows, only
// about whose directory is current.
//
// Used by the identity endpoints before they mutate and by the push pipeline for every synced op.
import {
  computeEffectiveSet,
  evaluateAllowance,
  evaluatePermission,
  parseLimitAmounts,
  type DirectoryGrant,
  type DirectoryRole,
  type DirectorySnapshot,
  type LimitAmounts,
  type PermissionAllowance,
  type PermissionQuery,
  type PermissionResult,
} from '@bolusi/core';
import type { TenantDb } from '@bolusi/db-server';

import { PermissionDeniedError } from '../identity/denial-audit.js';
import { permissionRegistry, TENANT_ADMIN_PERMISSION } from '../identity/permissions.js';

/**
 * The directory slice one user's evaluation reads: the user, their grants and the roles those grants
 * name, in the evaluator's own snapshot shape. Reads run under RLS, so a user of another tenant is
 * simply absent and denies.
 */
export async function loadUserDirectory(
  db: TenantDb,
  tenantId: string,
  userId: string,
): Promise<DirectorySnapshot> {
  const user = await db
    .selectFrom('users')
    .select(['status'])
    .where('id', '=', userId)
    .executeTakeFirst();
  const grantRows = await db
    .selectFrom('userRoles')
    .select(['roleId', 'storeId'])
    .where('userId', '=', userId)
    .execute();
  const roleIds = [...new Set(grantRows.map((g) => g.roleId))];
  const roleRows =
    roleIds.length === 0
      ? []
      : await db
          .selectFrom('roles')
          .select(['id', 'scopeType', 'limited'])
          .where('id', 'in', roleIds)
          .execute();
  const limitRows =
    roleIds.length === 0
      ? []
      : await db
          .selectFrom('roleLimits')
          .select(['roleId', 'storeId', 'kind', 'amount'])
          .where('roleId', 'in', roleIds)
          .execute();
  const permissionRows =
    roleIds.length === 0
      ? []
      : await db
          .selectFrom('rolePermissions')
          .select(['roleId', 'permissionId'])
          .where('roleId', 'in', roleIds)
          .execute();

  const roles = new Map<string, DirectoryRole>();
  for (const role of roleRows) {
    const ids = permissionRows.filter((p) => p.roleId === role.id).map((p) => p.permissionId);
    roles.set(role.id, {
      scopeType: role.scopeType,
      permissionIdsJson: JSON.stringify(ids),
      limits: role.limited ? limitsByStore(limitRows.filter((l) => l.roleId === role.id)) : null,
    });
  }
  const grants: DirectoryGrant[] = grantRows.map((g) => ({ roleId: g.roleId, storeId: g.storeId }));

  return {
    tenantId,
    users: user === undefined ? new Map() : new Map([[userId, { status: user.status }]]),
    roles,
    grantsByUser: new Map([[userId, grants]]),
  };
}

/** A limited role's `role_limits` rows as amounts per store; an unset kind is Rp 0. */
export function limitsByStore(
  rows: readonly { storeId: string; kind: string; amount: string | number | bigint }[],
): ReadonlyMap<string, LimitAmounts> {
  const raw = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const store = raw.get(row.storeId) ?? {};
    store[row.kind] = Number(row.amount);
    raw.set(row.storeId, store);
  }
  return new Map([...raw].map(([storeId, amounts]) => [storeId, parseLimitAmounts(amounts)]));
}

/** How far the user may use a permission (core authz/limits.ts), by a loaded directory. */
export function allowanceWithDirectory(
  directory: DirectorySnapshot,
  query: PermissionQuery,
): PermissionAllowance {
  return evaluateAllowance(permissionRegistry, directory, query);
}

/** Evaluate one query against a loaded directory, with the server's permission registry. */
export function evaluateWithDirectory(
  directory: DirectorySnapshot,
  query: PermissionQuery,
): PermissionResult {
  return evaluatePermission(permissionRegistry, directory, query);
}

/**
 * Does `userId` hold `permissionId` in evaluation scope `storeId`? Fail-closed: unknown permission,
 * inactive or absent user, or no matching grant → false. For a store-scoped permission a tenant-wide
 * grant satisfies every store; for a tenant-scoped permission only a tenant-wide grant counts.
 */
export async function hasPermission(db: TenantDb, params: PermissionQuery): Promise<boolean> {
  const directory = await loadUserDirectory(db, params.tenantId, params.userId);
  return evaluateWithDirectory(directory, params).allowed;
}

/**
 * Does the loaded user hold the store-scoped `permissionId` through a TENANT-WIDE grant, the one
 * kind that also covers rows with no store? The evaluator answers per store; this is its step 4
 * read with no store (a store-specific grant never counts), gated on the same active-user rule.
 */
function holdsTenantWide(directory: DirectorySnapshot, userId: string, permissionId: string) {
  return (
    directory.users.get(userId)?.status === 'active' &&
    permissionRegistry.get(permissionId) !== undefined &&
    computeEffectiveSet(directory, userId, null).storeScope.has(permissionId)
  );
}

/**
 * Where `userId` holds the store-scoped `permissionId`, for a list that spans the tenant: every store
 * the evaluator allows, and whether the grant is tenant-wide (which also covers store-less rows).
 */
export async function storesGranting(
  db: TenantDb,
  params: Omit<PermissionQuery, 'storeId'>,
): Promise<{ readonly tenantWide: boolean; readonly storeIds: readonly string[] }> {
  const directory = await loadUserDirectory(db, params.tenantId, params.userId);
  const stores = await db.selectFrom('stores').select('id').execute();
  const storeIds = stores
    .map((store) => store.id)
    .filter((storeId) => evaluateWithDirectory(directory, { ...params, storeId }).allowed);
  return { tenantWide: holdsTenantWide(directory, params.userId, params.permissionId), storeIds };
}

/**
 * Throw `403 PERMISSION_DENIED` unless `userId` holds `permissionId` in EVERY one of `storeIds`
 * (one directory read for all of them). An empty list is only a tenant-wide holder's business: a
 * loop that ran zero times must never mean "allowed".
 */
export async function requirePermissionInStores(
  db: TenantDb,
  params: Omit<PermissionQuery, 'storeId'>,
  storeIds: Iterable<string>,
): Promise<void> {
  const directory = await loadUserDirectory(db, params.tenantId, params.userId);
  const deny = (scopeStoreId: string | null) =>
    new PermissionDeniedError({
      actorUserId: params.userId,
      permissionId: params.permissionId,
      scopeStoreId,
      reason: 'not_granted',
    });
  let checked = 0;
  for (const storeId of storeIds) {
    if (!evaluateWithDirectory(directory, { ...params, storeId }).allowed) throw deny(storeId);
    checked += 1;
  }
  if (checked === 0 && !holdsTenantWide(directory, params.userId, params.permissionId)) {
    throw deny(null);
  }
}

/**
 * Throw `403 PERMISSION_DENIED` unless `userId` holds `permissionId` in scope `storeId`. This is
 * the server's single §4.5 permission-enforcement point (02-permissions §4) — so it *declares* the
 * FR-1045 denial (reason `not_granted`, the §7 umbrella for an evaluator miss) by throwing a
 * `PermissionDeniedError` carrying the audit context; app.ts `onError` is the single point that
 * writes the `identity_audit` row (mirror of task 44's client single-emitter split).
 */
export async function requirePermission(db: TenantDb, params: PermissionQuery): Promise<void> {
  if (!(await hasPermission(db, params))) {
    throw new PermissionDeniedError({
      actorUserId: params.userId,
      permissionId: params.permissionId,
      scopeStoreId: params.storeId,
      reason: 'not_granted',
    });
  }
}

/**
 * Count active tenant admins (02-permissions §5.4.4): active users holding `auth.role_manage` via a
 * TENANT-WIDE grant. `excludeUserId` drops one user from the count (the last-admin guard asks
 * "would deactivating THIS user leave zero?").
 */
export async function countActiveTenantAdmins(
  db: TenantDb,
  tenantId: string,
  options: { excludeUserId?: string } = {},
): Promise<number> {
  // Candidates are the users with any grant of a role carrying the permission; the evaluator then
  // decides each one, so the count can never call someone an admin whom `isTenantAdmin` would not.
  let query = db
    .selectFrom('userRoles')
    .innerJoin('rolePermissions', 'rolePermissions.roleId', 'userRoles.roleId')
    .where('rolePermissions.permissionId', '=', TENANT_ADMIN_PERMISSION)
    .select('userRoles.userId')
    .distinct();
  if (options.excludeUserId !== undefined) {
    query = query.where('userRoles.userId', '<>', options.excludeUserId);
  }
  const candidates = await query.execute();
  let count = 0;
  for (const { userId } of candidates) {
    if (await isTenantAdmin(db, tenantId, userId)) count += 1;
  }
  return count;
}

/** Whether `userId` is a tenant admin (active + tenant-wide `auth.role_manage`), per the evaluator. */
export async function isTenantAdmin(
  db: TenantDb,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  return hasPermission(db, {
    userId,
    tenantId,
    storeId: null,
    permissionId: TENANT_ADMIN_PERMISSION,
  });
}
