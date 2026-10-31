// What a device may receive (permission-scoped sync, owner decisions 2026-10-31): the read
// permissions its pulls are filtered by. A shared store device (every device today) gets
// staff-level data: what the business's staff roles may read. Owner-only data, such as part costs,
// never lands on it; owners see that online. Roles, not people, decide it, so a store whose only
// staff so far is its owner still gets what a cashier would need at the counter.
import { isOwnerRoleOf, readSetOf, type ReadScopeRegistry } from '@bolusi/core';
import type { TenantDb } from '@bolusi/db-server';

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
