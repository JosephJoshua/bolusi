// Directory-backed §4.5 permission checks (api/02-auth §4.5; 02-permissions §5.2 algorithm run
// server-side against the server directory). The identity endpoints enforce this registry's
// permissions before mutating; ids are the exact 02-permissions §11 strings (never module-prefix
// variants) — resolved through PERMISSION_BY_ID so a typo is a miss, not a silent allow.
import type { TenantDb } from '@bolusi/db-server';

import { ApiError } from '../errors.js';
import { PERMISSION_BY_ID, TENANT_ADMIN_PERMISSION } from '../identity/permission-registry.js';

/**
 * 02-permissions §5.2 — does `userId` hold `permissionId` in evaluation scope `storeId`?
 * Fail-closed: unknown permission, inactive/absent user, or no matching grant → false. For a
 * store-scoped permission a tenant-wide grant (storeId = null) satisfies every store; for a
 * tenant-scoped permission ONLY a tenant-wide grant counts.
 */
export async function hasPermission(
  db: TenantDb,
  params: { userId: string; tenantId: string; storeId: string | null; permissionId: string },
): Promise<boolean> {
  const perm = PERMISSION_BY_ID.get(params.permissionId);
  if (perm === undefined) return false; // unknown_permission

  // The acting user must exist in THIS tenant (RLS scopes the read) and be active.
  const user = await db
    .selectFrom('users')
    .select(['status'])
    .where('id', '=', params.userId)
    .executeTakeFirst();
  if (user === undefined || user.status !== 'active') return false;

  if (perm.scope === 'store' && params.storeId === null) return false; // missing_scope

  const grants = await db
    .selectFrom('userRoles')
    .innerJoin('rolePermissions', 'rolePermissions.roleId', 'userRoles.roleId')
    .select('userRoles.storeId as grantStoreId')
    .where('userRoles.userId', '=', params.userId)
    .where('rolePermissions.permissionId', '=', params.permissionId)
    .execute();

  for (const g of grants) {
    if (perm.scope === 'tenant') {
      if (g.grantStoreId === null) return true;
    } else if (g.grantStoreId === null || g.grantStoreId === params.storeId) {
      return true;
    }
  }
  return false;
}

/** Throw `403 PERMISSION_DENIED` unless `userId` holds `permissionId` in scope `storeId`. */
export async function requirePermission(
  db: TenantDb,
  params: { userId: string; tenantId: string; storeId: string | null; permissionId: string },
): Promise<void> {
  if (!(await hasPermission(db, params))) {
    throw new ApiError('PERMISSION_DENIED');
  }
}

/**
 * Count active tenant admins (02-permissions §5.4.4): active users holding `auth.role_manage` via a
 * TENANT-WIDE grant. `excludeUserId` drops one user from the count (the last-admin guard asks
 * "would deactivating THIS user leave zero?").
 */
export async function countActiveTenantAdmins(
  db: TenantDb,
  options: { excludeUserId?: string } = {},
): Promise<number> {
  let query = db
    .selectFrom('userRoles')
    .innerJoin('rolePermissions', 'rolePermissions.roleId', 'userRoles.roleId')
    .innerJoin('users', 'users.id', 'userRoles.userId')
    .where('rolePermissions.permissionId', '=', TENANT_ADMIN_PERMISSION)
    .where('userRoles.storeId', 'is', null)
    .where('users.status', '=', 'active')
    .select('userRoles.userId')
    .distinct();
  if (options.excludeUserId !== undefined) {
    query = query.where('userRoles.userId', '<>', options.excludeUserId);
  }
  const rows = await query.execute();
  return rows.length;
}

/** Whether `userId` is a tenant admin (active + tenant-wide `auth.role_manage`). */
export async function isTenantAdmin(db: TenantDb, userId: string): Promise<boolean> {
  const row = await db
    .selectFrom('userRoles')
    .innerJoin('rolePermissions', 'rolePermissions.roleId', 'userRoles.roleId')
    .where('rolePermissions.permissionId', '=', TENANT_ADMIN_PERMISSION)
    .where('userRoles.storeId', 'is', null)
    .where('userRoles.userId', '=', userId)
    .select('userRoles.userId')
    .executeTakeFirst();
  return row !== undefined;
}
