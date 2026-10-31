// Personal devices (permission-scoped sync, owner decisions 2026-10-31). A device set up as one
// person's own phone is synced what that person may read, and only they sign in on it; every other
// device is shared by its store and gets staff-level data.
//
// Who it may be set up for: the person setting it up, or one of the store's active people who
// already has a PIN and may see nothing the person setting it up may not. A person without a PIN
// could never sign in on it (a first PIN is only ever the enrolling owner's to make on the phone
// itself), so offering them would make a phone nobody can use. And a phone set up for someone who
// sees more, such as a manager setting up the owner's phone, would put data the manager may not see
// on a phone the manager is holding.
import { computeEffectiveSet } from '@bolusi/core';
import type { TenantDb } from '@bolusi/db-server';

import { loadUserDirectory } from '../auth/permissions.js';

export interface PersonalChoice {
  readonly id: string;
  readonly name: string;
}

/** Who a device at `storeId` may be set up for, by name, the caller first. */
export async function personalDeviceChoices(
  db: TenantDb,
  tenantId: string,
  storeId: string,
  callerUserId: string,
): Promise<readonly PersonalChoice[]> {
  const rows = await db
    .selectFrom('userStores')
    .innerJoin('users', 'users.id', 'userStores.userId')
    .leftJoin('userPinVerifiers', 'userPinVerifiers.userId', 'users.id')
    .select(['users.id as id', 'users.name as name', 'userPinVerifiers.userId as pinUserId'])
    .where('userStores.storeId', '=', storeId)
    .where('users.status', '=', 'active')
    .where('users.isSystem', '=', false)
    .execute();
  const permissionsOf = async (userId: string): Promise<ReadonlySet<string>> => {
    const effective = computeEffectiveSet(
      await loadUserDirectory(db, tenantId, userId),
      userId,
      storeId,
    );
    return new Set([...effective.tenantScope, ...effective.storeScope]);
  };
  const callerHolds = await permissionsOf(callerUserId);
  const offered: { id: string; name: string }[] = [];
  for (const row of rows) {
    if (row.id === callerUserId) {
      offered.push(row);
      continue;
    }
    if (row.pinUserId === null) continue;
    const holds = await permissionsOf(row.id);
    if ([...holds].every((permission) => callerHolds.has(permission))) offered.push(row);
  }
  return offered
    .map((row) => ({ id: row.id, name: row.name }))
    .sort((a, b) =>
      a.id === callerUserId ? -1 : b.id === callerUserId ? 1 : a.name.localeCompare(b.name),
    );
}
