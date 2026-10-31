// What a device may receive (permission-scoped sync, owner decisions 2026-10-31): the read
// permissions its pulls are filtered by.
//   - A shared store device gets staff-level data: what the business's staff roles may read.
//     Owner-only data, such as part costs, never lands on it; owners see that online. Roles, not
//     people, decide it, so a store whose only staff so far is its owner still gets what a cashier
//     would need at the counter.
//   - A personal device (one person's own phone) gets what that person may read at its store, and
//     nothing once they are deactivated.
import {
  computeEffectiveSet,
  isOwnerRoleOf,
  readSetOf,
  type ReadScopeRegistry,
} from '@bolusi/core';
import type { TenantDb } from '@bolusi/db-server';

import { loadUserDirectory } from '../auth/permissions.js';

/** The device a read set is for: its store, and its person when it is someone's own. */
export interface ReadSetDevice {
  readonly storeId: string | null;
  readonly personalUserId: string | null;
}

/** The read set of a device, shared or personal. */
export async function deviceReadSet(
  db: TenantDb,
  tenantId: string,
  device: ReadSetDevice,
  registry: ReadScopeRegistry,
): Promise<readonly string[]> {
  if (device.personalUserId === null) return sharedDeviceReadSet(db, tenantId, registry);
  return personalDeviceReadSet(db, tenantId, device.personalUserId, device.storeId, registry);
}

/** What one person may read at the device's store (tenant-wide grants count in every store). */
async function personalDeviceReadSet(
  db: TenantDb,
  tenantId: string,
  userId: string,
  storeId: string | null,
  registry: ReadScopeRegistry,
): Promise<readonly string[]> {
  const directory = await loadUserDirectory(db, tenantId, userId);
  if (directory.users.get(userId)?.status !== 'active') return [];
  const effective = computeEffectiveSet(directory, userId, storeId);
  return readSetOf(registry, new Set([...effective.tenantScope, ...effective.storeScope]));
}

/** The read set of a shared store device: the read permissions any non-owner role holds. */
export async function sharedDeviceReadSet(
  db: TenantDb,
  tenantId: string,
  registry: ReadScopeRegistry,
): Promise<readonly string[]> {
  const roles = await db
    .selectFrom('roles')
    .select(['id', 'scopeType'])
    .where('tenantId', '=', tenantId)
    .execute();
  const grants = await db
    .selectFrom('rolePermissions')
    .select(['roleId', 'permissionId'])
    .where('tenantId', '=', tenantId)
    .execute();
  const byRole = new Map<string, string[]>();
  for (const grant of grants) {
    const list = byRole.get(grant.roleId) ?? [];
    list.push(grant.permissionId);
    byRole.set(grant.roleId, list);
  }
  const held = new Set<string>();
  for (const role of roles) {
    const permissions = byRole.get(role.id) ?? [];
    if (isOwnerRoleOf(role.scopeType, permissions)) continue;
    for (const permission of permissions) held.add(permission);
  }
  return readSetOf(registry, held);
}
