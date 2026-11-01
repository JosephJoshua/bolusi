// What a device may receive (permission-scoped sync, owner decisions 2026-10-31): the read
// permissions its pulls are filtered by.
//   - A shared store device gets what the store's active staff may read (least privilege, owner
//     decision 2026-11-01): people, not roles, so a role nobody there holds adds nothing, and owner
//     roles never count. Anyone who may read more, an owner or anyone else, reads the rest online
//     for their session (a person session pull), never onto the device's disk.
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
  if (device.personalUserId === null) return sharedDeviceReadSet(db, device.storeId, registry);
  return personalDeviceReadSet(db, tenantId, device.personalUserId, device.storeId, registry);
}

/**
 * What a person signed in on a device may read there beyond what the device holds: the part they
 * read online for their session. The same for everyone: an owner, a manager given more, or nobody
 * (empty) on a device that already holds all they may read.
 */
export async function personExtraReadSet(
  db: TenantDb,
  tenantId: string,
  device: ReadSetDevice,
  userId: string,
  registry: ReadScopeRegistry,
): Promise<readonly string[]> {
  const held = new Set(await deviceReadSet(db, tenantId, device, registry));
  const person = await personalDeviceReadSet(db, tenantId, userId, device.storeId, registry);
  return person.filter((read) => !held.has(read));
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

/**
 * The read set of a shared store device: what the store's active staff may read there. People, not
 * roles: a role nobody at the store holds puts nothing on its devices, and owner roles never count
 * (their extras are read online, the same way as anyone else's reads beyond the device's).
 */
export async function sharedDeviceReadSet(
  db: TenantDb,
  storeId: string | null,
  registry: ReadScopeRegistry,
): Promise<readonly string[]> {
  if (storeId === null) return readSetOf(registry, new Set());
  const grants = await db
    .selectFrom('userRoles')
    .innerJoin('users', 'users.id', 'userRoles.userId')
    .innerJoin('userStores', (join) =>
      join
        .onRef('userStores.userId', '=', 'userRoles.userId')
        .onRef('userStores.storeId', '=', 'userRoles.storeId'),
    )
    .innerJoin('roles', 'roles.id', 'userRoles.roleId')
    .select(['roles.id as roleId', 'roles.scopeType as scopeType'])
    .where('userRoles.storeId', '=', storeId)
    .where('users.status', '=', 'active')
    .where('users.isSystem', '=', false)
    .execute();
  const roleIds = [...new Set(grants.map((g) => g.roleId))];
  const permissions =
    roleIds.length === 0
      ? []
      : await db
          .selectFrom('rolePermissions')
          .select(['roleId', 'permissionId'])
          .where('roleId', 'in', roleIds)
          .execute();
  const byRole = new Map<string, string[]>();
  for (const row of permissions) {
    const list = byRole.get(row.roleId) ?? [];
    list.push(row.permissionId);
    byRole.set(row.roleId, list);
  }
  const held = new Set<string>();
  for (const grant of grants) {
    const rolePermissions = byRole.get(grant.roleId) ?? [];
    if (isOwnerRoleOf(grant.scopeType, rolePermissions)) continue;
    for (const permission of rolePermissions) held.add(permission);
  }
  return readSetOf(registry, held);
}
