// What a device may receive (permission-scoped sync, owner decisions 2026-10-31): the read
// permissions its pulls are filtered by.
//   - A shared store device gets what the store's active staff may read (least privilege, owner
//     decision 2026-11-01): people, not roles, so a role nobody there holds adds nothing, and owner
//     roles never count. Anyone who may read more, an owner or anyone else, reads the rest online
//     for their session (a person session pull), never onto the device's disk. A store with no
//     active staff yet counts its owners instead (owner decision 2026-11-01): they are the only
//     people there, so a one-person shop works offline; the first staff person narrows it.
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
  if (device.personalUserId === null) {
    return sharedDeviceReadSet(db, tenantId, device.storeId, registry);
  }
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
 * (their extras are read online, the same way as anyone else's reads beyond the device's). With no
 * active staff at the store yet, what its owners may read there.
 */
export async function sharedDeviceReadSet(
  db: TenantDb,
  tenantId: string,
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
    .select(['userRoles.userId as userId', 'roles.id as roleId', 'roles.scopeType as scopeType'])
    .where('userRoles.storeId', '=', storeId)
    .where('users.status', '=', 'active')
    .where('users.isSystem', '=', false)
    .execute();
  const byRole = await permissionsByRole(
    db,
    grants.map((grant) => grant.roleId),
  );
  const held = new Set<string>();
  const staff = new Set<string>();
  for (const grant of grants) {
    const rolePermissions = byRole.get(grant.roleId) ?? [];
    if (isOwnerRoleOf(grant.scopeType, rolePermissions)) continue;
    staff.add(grant.userId);
    for (const permission of rolePermissions) held.add(permission);
  }
  if (staff.size > 0) return readSetOf(registry, held);
  return storeOwnersReadSet(db, tenantId, storeId, registry);
}

/** What the store's active owners may read there: tenant-wide owners, and owners of this store. */
async function storeOwnersReadSet(
  db: TenantDb,
  tenantId: string,
  storeId: string,
  registry: ReadScopeRegistry,
): Promise<readonly string[]> {
  const grants = await db
    .selectFrom('userRoles')
    .innerJoin('users', 'users.id', 'userRoles.userId')
    .innerJoin('roles', 'roles.id', 'userRoles.roleId')
    .select(['userRoles.userId as userId', 'roles.id as roleId', 'roles.scopeType as scopeType'])
    .where((where) =>
      where.or([where('userRoles.storeId', '=', storeId), where('userRoles.storeId', 'is', null)]),
    )
    .where('users.status', '=', 'active')
    .where('users.isSystem', '=', false)
    .execute();
  const byRole = await permissionsByRole(
    db,
    grants.map((grant) => grant.roleId),
  );
  const owners = new Set(
    grants
      .filter((grant) => isOwnerRoleOf(grant.scopeType, byRole.get(grant.roleId) ?? []))
      .map((grant) => grant.userId),
  );
  const reads = new Set<string>();
  for (const owner of owners) {
    for (const read of await personalDeviceReadSet(db, tenantId, owner, storeId, registry)) {
      reads.add(read);
    }
  }
  return [...reads].sort();
}

/** Each role's permission ids. */
async function permissionsByRole(
  db: TenantDb,
  roleIds: readonly string[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  const unique = [...new Set(roleIds)];
  const rows =
    unique.length === 0
      ? []
      : await db
          .selectFrom('rolePermissions')
          .select(['roleId', 'permissionId'])
          .where('roleId', 'in', unique)
          .execute();
  const byRole = new Map<string, string[]>();
  for (const row of rows) {
    const list = byRole.get(row.roleId) ?? [];
    list.push(row.permissionId);
    byRole.set(row.roleId, list);
  }
  return byRole;
}
