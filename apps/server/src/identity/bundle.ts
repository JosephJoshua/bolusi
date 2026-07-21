// Device bundle build + RFC 8785 etag (api/02-auth §5.2). The bundle is the device's slice of the
// directory: this store's users, their grant tuples (filtered), their verifiers (minimized), and
// the tenant's role/permission snapshots.
//
// Two structural guarantees this builder enforces, and their tests are the crown jewels:
//   - GRANTS-TUPLE FILTERING (§5.2): a user's grants are filtered to tenant-wide (storeId = null) +
//     grants scoped to THIS bundle's store. A multi-store user's store-2-only grant NEVER reaches
//     the store-1 device.
//   - VERIFIER MINIMIZATION (§5.1, security-guide §5.2): only this store's ACTIVE users carry a
//     verifier; deactivated users appear with pinVerifier: null; a user unassigned from the store
//     disappears entirely.
import { canonicalizeJcs, type JsonValue } from '@bolusi/core';
import type { TenantDb } from '@bolusi/db-server';

import { sha256Hex } from '../crypto/index.js';
import {
  clampIdleLock,
  IDLE_LOCK_DEFAULT,
  type DeviceBundle,
  type PinVerifier,
} from '@bolusi/schemas';
import { PERMISSIONS } from './permissions.js';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Read idleLockSeconds from the tenant configuration JSON, clamped, defaulting to 300. */
function readIdleLock(configuration: unknown): number {
  if (configuration !== null && typeof configuration === 'object') {
    const raw = (configuration as Record<string, unknown>)['idleLockSeconds'];
    if (typeof raw === 'number' && Number.isFinite(raw)) return clampIdleLock(raw);
  }
  return IDLE_LOCK_DEFAULT;
}

function toVerifier(row: {
  salt: string;
  params: unknown;
  hash: string;
  asOfTimestamp: string | number;
  asOfDeviceId: string;
  asOfSeq: string | number;
}): PinVerifier {
  const params = (row.params ?? {}) as { m?: number; t?: number; p?: number };
  return {
    algorithm: 'argon2id',
    saltB64: row.salt,
    mKiB: Number(params.m),
    t: Number(params.t),
    p: 1,
    hashB64: row.hash,
    asOf: {
      timestamp: Number(row.asOfTimestamp),
      deviceId: row.asOfDeviceId,
      seq: Number(row.asOfSeq),
    },
  };
}

/**
 * Build the bundle for a device at `(tenantId, storeId)`, inside the caller's forTenant tx. Arrays
 * are sorted deterministically so the RFC 8785 etag is stable across identical directory states
 * (JCS canonicalizes object keys but not array element order).
 */
export async function buildBundle(
  db: TenantDb,
  tenantId: string,
  storeId: string,
): Promise<DeviceBundle> {
  const tenant = await db
    .selectFrom('tenants')
    .select(['id', 'name', 'configuration'])
    .where('id', '=', tenantId)
    .executeTakeFirstOrThrow();
  const store = await db
    .selectFrom('stores')
    .select(['id', 'name'])
    .where('id', '=', storeId)
    .executeTakeFirstOrThrow();

  const storeUsers = await db
    .selectFrom('userStores')
    .select('userId')
    .where('storeId', '=', storeId)
    .execute();
  const userIds = storeUsers.map((r) => r.userId);

  const users =
    userIds.length > 0
      ? await db
          .selectFrom('users')
          .select(['id', 'name', 'photoMediaId', 'status'])
          .where('id', 'in', userIds)
          .where('isSystem', '=', false) // the system actor never appears in any bundle (§3.6)
          .execute()
      : [];

  // Grants filtered to this store + tenant-wide (§5.2) — the store-2-only grant is excluded here.
  const grants =
    userIds.length > 0
      ? await db
          .selectFrom('userRoles')
          .select(['userId', 'roleId', 'storeId'])
          .where('userId', 'in', userIds)
          .where((eb) => eb.or([eb('storeId', '=', storeId), eb('storeId', 'is', null)]))
          .execute()
      : [];

  const verifiers =
    userIds.length > 0
      ? await db
          .selectFrom('userPinVerifiers')
          .select(['userId', 'salt', 'params', 'hash', 'asOfTimestamp', 'asOfDeviceId', 'asOfSeq'])
          .where('userId', 'in', userIds)
          .execute()
      : [];
  const verifierByUser = new Map(verifiers.map((v) => [v.userId, v]));

  const roles = await db
    .selectFrom('roles')
    .select(['id', 'name', 'scopeType', 'isSystemDefault'])
    .where('tenantId', '=', tenantId)
    .execute();
  const rolePerms = await db
    .selectFrom('rolePermissions')
    .select(['roleId', 'permissionId'])
    .where('tenantId', '=', tenantId)
    .execute();
  const permsByRole = new Map<string, string[]>();
  for (const rp of rolePerms) {
    const list = permsByRole.get(rp.roleId) ?? [];
    list.push(rp.permissionId);
    permsByRole.set(rp.roleId, list);
  }

  const bundleUsers = users
    .map((u) => {
      const verifierRow = verifierByUser.get(u.id);
      const status = u.status === 'deactivated' ? 'deactivated' : 'active';
      return {
        id: u.id,
        name: u.name,
        photoMediaId: u.photoMediaId,
        status: status as 'active' | 'deactivated',
        grants: grants
          .filter((g) => g.userId === u.id)
          .map((g) => ({ roleId: g.roleId, storeId: g.storeId }))
          .sort((a, b) =>
            `${a.roleId}${a.storeId ?? NIL_UUID}`.localeCompare(
              `${b.roleId}${b.storeId ?? NIL_UUID}`,
            ),
          ),
        // Verifier minimization: only ACTIVE users of this store carry a verifier.
        pinVerifier:
          status === 'active' && verifierRow !== undefined ? toVerifier(verifierRow) : null,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    tenant: { id: tenant.id, name: tenant.name },
    store: { id: store.id, name: store.name },
    settings: { idleLockSeconds: readIdleLock(tenant.configuration) },
    users: bundleUsers,
    rolesSnapshot: roles
      .map((r) => ({
        id: r.id,
        name: r.name,
        scopeType: r.scopeType === 'tenant' ? ('tenant' as const) : ('store' as const),
        isSystemDefault: r.isSystemDefault,
        permissionIds: (permsByRole.get(r.id) ?? []).slice().sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    permissionsSnapshot: PERMISSIONS.map((p) => ({
      id: p.id,
      module: p.module,
      action: p.action,
      scope: p.scope,
      isDangerous: p.isDangerous,
      description: p.description,
    })).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** etag = SHA-256 hex of the RFC 8785 canonicalization of the bundle (api/02-auth §5.2). */
export function bundleEtag(bundle: DeviceBundle): string {
  return sha256Hex(canonicalizeJcs(bundle as unknown as JsonValue));
}
