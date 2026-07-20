// Persist a device bundle into the client directory tables (api/02-auth §5.2; 10-db §9.5).
//
// The mirrors are OVERWRITTEN wholesale (users/roles/grants) — the bundle is the truth, no fold, no
// merge, no conflicts (03-state-machines §6). The ONE exception is `user_pin_verifiers`, which
// merges by the §5.3 greatest-`asOf` rule against any local write, so a PIN changed offline on this
// device is not clobbered by a staler bundle snapshot. Verifier minimization is already done by the
// server (bundle.ts) — only this store's active users carry a verifier — so this persists what the
// bundle contains and DELETES the rest (deactivation / unassignment remove the verifier, §5.2).
//
// Callers wrap this in a transaction and, after it commits, invalidate the permission memo
// (`evaluator.onBundleRefresh()`, 02-permissions §6) — the mirrors it reads just changed.
import type { Kysely } from 'kysely';

import { TENANT_ID_META_KEY } from '../authz/directory.js';
import type { DeviceBundle } from './ports.js';
import {
  deleteVerifier,
  readVerifier,
  replaceRolesDirectory,
  replaceUserRolesDirectory,
  replaceUsersDirectory,
  STORE_NAME_META_KEY,
  TENANT_NAME_META_KEY,
  verifierUserIds,
  writeMeta,
  writeVerifier,
  type DirectoryGrantRow,
} from './repo.js';
import { assertVerifierInBounds, chooseEffectiveVerifier } from './verifier.js';

/**
 * Apply `bundle` to the client directory (api/02-auth §5.2). Idempotent: re-applying the same bundle
 * yields the same tables. The tenant lands in `meta_kv` (single-tenant device, 10-db §9.5) so the
 * evaluator's `tenantId` matches (authz/directory.ts).
 */
export async function applyBundle<DB>(db: Kysely<DB>, bundle: DeviceBundle): Promise<void> {
  await writeMeta(db, TENANT_ID_META_KEY, bundle.tenant.id);

  // The store/tenant DISPLAY NAMES ride every bundle (api/02-auth §5.2). Persist them HERE — the one
  // place that sees them on every refresh — so a rename delivered on the next pull refreshes the
  // on-device names (task 109); this is the SINGLE writer of these two keys. `deviceName` is NOT on
  // the bundle (it is the owner-typed genesis value) and stays enrollment-owned (apps/mobile). Unlike
  // `storeId` (never rewritten — the §7.4 store binding is irreversible), only the display names refresh.
  await writeMeta(db, STORE_NAME_META_KEY, bundle.store.name);
  await writeMeta(db, TENANT_NAME_META_KEY, bundle.tenant.name);

  await replaceUsersDirectory(
    db,
    bundle.users.map((u) => ({
      id: u.id,
      name: u.name,
      photoMediaId: u.photoMediaId,
      status: u.status,
    })),
  );

  await replaceRolesDirectory(
    db,
    bundle.rolesSnapshot.map((r) => ({
      id: r.id,
      name: r.name,
      scopeType: r.scopeType,
      isSystemDefault: r.isSystemDefault,
      permissionIds: r.permissionIds,
    })),
  );

  const grants: DirectoryGrantRow[] = bundle.users.flatMap((u) =>
    u.grants.map((g) => ({ userId: u.id, roleId: g.roleId, storeId: g.storeId })),
  );
  await replaceUserRolesDirectory(db, grants);

  await applyVerifiers(db, bundle);
}

/**
 * Merge the bundle's verifiers into `user_pin_verifiers` (§5.3), and delete every verifier the
 * bundle does not carry — a deactivated user (`pinVerifier: null`) or one unassigned from the store
 * (absent from `bundle.users`) loses their local verifier (§5.2).
 */
async function applyVerifiers<DB>(db: Kysely<DB>, bundle: DeviceBundle): Promise<void> {
  const keep = new Set<string>();
  for (const user of bundle.users) {
    if (user.pinVerifier === null) continue;
    assertVerifierInBounds(user.pinVerifier); // SEC-AUTH-01 — re-check on the device, defence in depth
    const existing = await readVerifier(db, user.id);
    const winner = chooseEffectiveVerifier(existing, user.pinVerifier);
    if (winner !== null) {
      await writeVerifier(db, user.id, winner);
      keep.add(user.id);
    }
  }
  // Every verifier NOT in `keep` is stale directory data — the user was deactivated, lost their
  // verifier, or left the store. Delete it (verifier minimization, §5.1/§5.2).
  for (const userId of await verifierUserIds(db)) {
    if (!keep.has(userId)) await deleteVerifier(db, userId);
  }
}
