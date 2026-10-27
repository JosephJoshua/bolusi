// Users sub-router (api/02-auth §5.4). Bearer-guarded; the §4.5 matrix + the §5.4 anti-escalation
// rules are enforced here against the server directory.
import { compareCanonicalOrder, OWNER_POWER_PERMISSIONS } from '@bolusi/core';
import { buildPinVerifierRow, type TenantDb } from '@bolusi/db-server';
import { Hono } from 'hono';

import { resolveActingUser } from '../auth/acting-user.js';
import {
  countActiveTenantAdmins,
  hasPermission,
  isTenantAdmin,
  requirePermission,
  requirePermissionInStores,
} from '../auth/permissions.js';
import { TENANT_ADMIN_PERMISSION } from '../identity/permissions.js';
import { isUniqueViolation } from '../db-errors.js';
import type { ServerDeps } from '../deps.js';
import type { AppEnv } from '../env.js';
import { ApiError } from '../errors.js';
import { appendAudit } from '../identity/audit.js';
import { PermissionDeniedError } from '../identity/denial-audit.js';
import { IdentityError, withIdentityErrors } from '../identity/errors.js';
import { PERM } from '../identity/permissions.js';
import { enforce, IDENTITY_LIMITS } from '../identity/rate-limits.js';
import {
  CreateUserReq,
  PutPinVerifierReq,
  UpdateUserReq,
  type CanonicalRef,
} from '@bolusi/schemas';
import { zJson } from '../middleware/validator-hook.js';
import { createWithTenant, tenantIdFromContext } from '../tenant.js';
import { uuidv7 } from '../uuidv7.js';

const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** §9 quota: 100 user-management mutations / tenant / day (create + patch + status + pin-verifier). */
function enforceUsersQuota(deps: ServerDeps, tenantId: string, now: number): void {
  enforce(
    deps.identityRateStore.hit(
      `users:${tenantId}`,
      IDENTITY_LIMITS.usersPerTenantDay.limit,
      IDENTITY_LIMITS.usersPerTenantDay.windowMs,
      now,
    ),
  );
}

/** A verifier `asOf` beats the stored one iff it is strictly later in canonical order (§5.3). */
function isNewer(candidate: CanonicalRef, stored: CanonicalRef): boolean {
  return compareCanonicalOrder(candidate, stored) > 0;
}

async function targetStoreIds(db: TenantDb, userId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('userStores')
    .select('storeId')
    .where('userId', '=', userId)
    .execute();
  return rows.map((r) => r.storeId);
}

/**
 * Owner powers (owner decision 2026-10-27): only a tenant admin, the main owner, may make someone an
 * owner, or rename, re-role, deactivate or reactivate an owner. An owner role is one that is
 * tenant-wide or holds power over other accounts (core `OWNER_POWER_PERMISSIONS`, which the device
 * uses to decide what to offer). A store owner manages the cashiers and technicians of their own
 * store, never a peer owner, so two store owners cannot remove each other.
 */
async function rolesConferOwnerPowers(
  db: TenantDb,
  roles: readonly { readonly id: string; readonly scopeType: string }[],
): Promise<boolean> {
  if (roles.some((r) => r.scopeType === 'tenant')) return true;
  if (roles.length === 0) return false;
  const row = await db
    .selectFrom('rolePermissions')
    .select('roleId')
    .where(
      'roleId',
      'in',
      roles.map((r) => r.id),
    )
    .where('permissionId', 'in', OWNER_POWER_PERMISSIONS)
    .executeTakeFirst();
  return row !== undefined;
}

async function holdsOwnerPowers(db: TenantDb, userId: string): Promise<boolean> {
  const roles = await db
    .selectFrom('userRoles')
    .innerJoin('roles', 'roles.id', 'userRoles.roleId')
    .select(['roles.id', 'roles.scopeType'])
    .where('userRoles.userId', '=', userId)
    .execute();
  return rolesConferOwnerPowers(db, roles);
}

/** Throw the owner-powers restriction unless the acting user is a tenant admin. */
async function requireTenantAdmin(
  db: TenantDb,
  acting: {
    readonly userId: string;
    readonly tenantId: string;
    readonly deviceStoreId: string | null;
  },
  permissionId: string,
): Promise<void> {
  if (await isTenantAdmin(db, acting.tenantId, acting.userId)) return;
  // A handler-declared restriction, not a plain requirePermission miss, so the denial lands in the
  // FR-1045 trail (§7) with its reason.
  throw new PermissionDeniedError({
    actorUserId: acting.userId,
    permissionId,
    scopeStoreId: acting.deviceStoreId,
    reason: 'restriction_violated',
  });
}

/** Load the named roles of this tenant; any id that is not one is a denial, not a 404. */
async function loadRoles(
  db: TenantDb,
  roleIds: readonly string[],
): Promise<{ readonly id: string; readonly scopeType: string }[]> {
  const roles = await db
    .selectFrom('roles')
    .select(['id', 'scopeType'])
    .where('id', 'in', roleIds)
    .execute();
  if (roles.length !== new Set(roleIds).size) throw new ApiError('PERMISSION_DENIED');
  return roles;
}

/** Grant `roles` to `userId`: a tenant role once with no store, a store role in each store. */
async function writeRoleGrants(
  db: TenantDb,
  tenantId: string,
  userId: string,
  roles: readonly { readonly id: string; readonly scopeType: string }[],
  storeIds: readonly string[],
): Promise<void> {
  for (const role of roles) {
    if (role.scopeType === 'tenant') {
      await db
        .insertInto('userRoles')
        .values({ tenantId, userId, roleId: role.id, storeId: null })
        .execute();
    } else {
      for (const storeId of storeIds) {
        await db
          .insertInto('userRoles')
          .values({ tenantId, userId, roleId: role.id, storeId })
          .execute();
      }
    }
  }
}

export function createUsersRouter(deps: ServerDeps) {
  const withTenant = createWithTenant(deps.forTenant);

  return (
    new Hono<AppEnv>()
      // ---- POST /v1/users (§5.4) ----
      .post('/', zJson(CreateUserReq), (c) =>
        withIdentityErrors(c, async () => {
          const body = c.req.valid('json');
          const t = deps.now();
          const tenantId = tenantIdFromContext(c);
          enforceUsersQuota(deps, tenantId, t);

          const userId = await withTenant(c, async (db) => {
            const acting = await resolveActingUser(c, db);

            // Store-boundary (§5.4.3): the creator must hold auth.user_create in EVERY target store,
            // and each store must exist in this tenant.
            for (const storeId of body.storeIds) {
              const store = await db
                .selectFrom('stores')
                .select('id')
                .where('id', '=', storeId)
                .executeTakeFirst();
              if (store === undefined) throw new ApiError('PERMISSION_DENIED');
              await requirePermission(db, {
                userId: acting.userId,
                tenantId,
                storeId,
                permissionId: PERM.userCreate,
              });
            }

            // Roles must exist in this tenant. An owner role (tenant-wide, or with power over other
            // accounts) needs a tenant admin: this is what stops a store_owner from minting a
            // main_owner or another store_owner (§5.4.2 tenant-grant rule, widened 2026-10-27).
            const roles = await loadRoles(db, body.roleIds);
            if (await rolesConferOwnerPowers(db, roles)) {
              await requireTenantAdmin(db, acting, TENANT_ADMIN_PERMISSION);
            }

            const newUserId = uuidv7(t);
            const passwordVerifier =
              body.password !== null ? await deps.passwordKdf.createVerifier(body.password) : null;

            try {
              await db
                .insertInto('users')
                .values({
                  id: newUserId,
                  tenantId,
                  name: body.name,
                  loginIdentifier: body.loginIdentifier,
                  passwordVerifier,
                  status: 'active',
                  isSystem: false,
                  createdAt: BigInt(t),
                  createdBy: acting.userId,
                })
                .execute();
            } catch (err) {
              // The login_identifier UNIQUE index is GLOBAL (not RLS-subject) — a cross-tenant
              // collision surfaces here as a unique violation.
              if (isUniqueViolation(err)) throw new IdentityError('LOGIN_IDENTIFIER_TAKEN');
              throw err;
            }

            for (const storeId of body.storeIds) {
              await db
                .insertInto('userStores')
                .values({ userId: newUserId, storeId, tenantId })
                .execute();
            }
            await writeRoleGrants(db, tenantId, newUserId, roles, body.storeIds);
            if (body.pinVerifier !== null) {
              await writeVerifier(db, tenantId, newUserId, body.pinVerifier);
            }

            await appendAudit(db, tenantId, {
              actorUserId: acting.userId,
              action: 'user.created',
              entityType: 'user',
              entityId: newUserId,
              after: {
                name: body.name,
                loginIdentifier: body.loginIdentifier,
                storeIds: body.storeIds,
                roleIds: body.roleIds,
                // password + pinVerifier are stripped by the audit redactor.
                password: body.password,
                pinVerifier: body.pinVerifier,
              },
              at: t,
            });

            return newUserId;
          });

          return c.json({ userId }, 201);
        }),
      )

      // ---- PATCH /v1/users/:userId (§5.4) ----
      .patch('/:userId', zJson(UpdateUserReq), (c) =>
        withIdentityErrors(c, async () => {
          const targetUserId = c.req.param('userId');
          if (!LOWERCASE_UUID.test(targetUserId)) throw new ApiError('NOT_FOUND');
          const body = c.req.valid('json');
          const t = deps.now();
          const tenantId = tenantIdFromContext(c);
          enforceUsersQuota(deps, tenantId, t);

          await withTenant(c, async (db) => {
            const acting = await resolveActingUser(c, db);
            const target = await db
              .selectFrom('users')
              .select(['id'])
              .where('id', '=', targetUserId)
              .executeTakeFirst();
            if (target === undefined) throw new ApiError('NOT_FOUND');

            // Editor must hold auth.user_edit for the target's current stores (and any new ones).
            const currentStores = await targetStoreIds(db, targetUserId);
            const scopeStores = new Set([...currentStores, ...(body.storeIds ?? [])]);
            await requirePermissionInStores(
              db,
              { userId: acting.userId, tenantId, permissionId: PERM.userEdit },
              scopeStores,
            );
            // Another owner is the main owner's to change (owner powers, above). Editing yourself is
            // not: your own grant changes still pass the role check below, so it cannot escalate.
            if (targetUserId !== acting.userId && (await holdsOwnerPowers(db, targetUserId))) {
              await requireTenantAdmin(db, acting, PERM.userEdit);
            }
            const roles = body.roleIds === undefined ? null : await loadRoles(db, body.roleIds);
            if (roles !== null && (await rolesConferOwnerPowers(db, roles))) {
              await requireTenantAdmin(db, acting, TENANT_ADMIN_PERMISSION);
            }

            const patch: { name?: string; photoMediaId?: string | null } = {};
            if (body.name !== undefined) patch.name = body.name;
            if (body.photoMediaId !== undefined) patch.photoMediaId = body.photoMediaId;
            if (Object.keys(patch).length > 0) {
              await db.updateTable('users').set(patch).where('id', '=', targetUserId).execute();
            }
            if (body.storeIds !== undefined) {
              // Each target store must exist in this tenant.
              for (const storeId of body.storeIds) {
                const store = await db
                  .selectFrom('stores')
                  .select('id')
                  .where('id', '=', storeId)
                  .executeTakeFirst();
                if (store === undefined) throw new ApiError('PERMISSION_DENIED');
              }
              await db.deleteFrom('userStores').where('userId', '=', targetUserId).execute();
              for (const storeId of body.storeIds) {
                await db
                  .insertInto('userStores')
                  .values({ userId: targetUserId, storeId, tenantId })
                  .execute();
              }
            }
            if (roles !== null) {
              // LAST_ADMIN_PROTECTED (§5.4.4) applies to taking the role away as much as to
              // deactivating: a tenant must always keep one active admin.
              if (
                (await isTenantAdmin(db, tenantId, targetUserId)) &&
                !roles.some((r) => r.scopeType === 'tenant') &&
                (await countActiveTenantAdmins(db, tenantId, { excludeUserId: targetUserId })) === 0
              ) {
                throw new IdentityError('LAST_ADMIN_PROTECTED');
              }
              await db.deleteFrom('userRoles').where('userId', '=', targetUserId).execute();
              await writeRoleGrants(
                db,
                tenantId,
                targetUserId,
                roles,
                body.storeIds ?? currentStores,
              );
            }

            await appendAudit(db, tenantId, {
              actorUserId: acting.userId,
              action: 'user.updated',
              entityType: 'user',
              entityId: targetUserId,
              after: {
                name: body.name,
                storeIds: body.storeIds,
                photoMediaId: body.photoMediaId,
                roleIds: body.roleIds,
              },
              at: t,
            });
          });

          return c.json({ userId: targetUserId });
        }),
      )

      // ---- POST /v1/users/:userId/deactivate (§5.4) ----
      .post('/:userId/deactivate', (c) =>
        withIdentityErrors(c, async () => {
          const targetUserId = c.req.param('userId');
          if (!LOWERCASE_UUID.test(targetUserId)) throw new ApiError('NOT_FOUND');
          const t = deps.now();
          const tenantId = tenantIdFromContext(c);
          enforceUsersQuota(deps, tenantId, t);

          await withTenant(c, async (db) => {
            const acting = await resolveActingUser(c, db);
            const target = await db
              .selectFrom('users')
              .select(['id', 'status'])
              .where('id', '=', targetUserId)
              .executeTakeFirst();
            if (target === undefined) throw new ApiError('NOT_FOUND');

            await requirePermissionInStores(
              db,
              { userId: acting.userId, tenantId, permissionId: PERM.userDeactivate },
              await targetStoreIds(db, targetUserId),
            );
            if (targetUserId !== acting.userId && (await holdsOwnerPowers(db, targetUserId))) {
              await requireTenantAdmin(db, acting, PERM.userDeactivate);
            }

            // LAST_ADMIN_PROTECTED (§5.4.4): deactivating the sole active tenant admin → 409. Server
            // endpoint check only — no projection guard, no Conflict record.
            if (await isTenantAdmin(db, tenantId, targetUserId)) {
              const remaining = await countActiveTenantAdmins(db, tenantId, {
                excludeUserId: targetUserId,
              });
              if (remaining === 0) throw new IdentityError('LAST_ADMIN_PROTECTED');
            }

            await db
              .updateTable('users')
              .set({ status: 'deactivated' })
              .where('id', '=', targetUserId)
              .execute();
            await appendAudit(db, tenantId, {
              actorUserId: acting.userId,
              action: 'user.deactivated',
              entityType: 'user',
              entityId: targetUserId,
              before: { status: 'active' },
              after: { status: 'deactivated' },
              at: t,
            });
          });

          return c.json({ userId: targetUserId, status: 'deactivated' });
        }),
      )

      // ---- POST /v1/users/:userId/reactivate (§5.4) ----
      .post('/:userId/reactivate', (c) =>
        withIdentityErrors(c, async () => {
          const targetUserId = c.req.param('userId');
          if (!LOWERCASE_UUID.test(targetUserId)) throw new ApiError('NOT_FOUND');
          const t = deps.now();
          const tenantId = tenantIdFromContext(c);
          enforceUsersQuota(deps, tenantId, t);

          await withTenant(c, async (db) => {
            const acting = await resolveActingUser(c, db);
            const target = await db
              .selectFrom('users')
              .select(['id'])
              .where('id', '=', targetUserId)
              .executeTakeFirst();
            if (target === undefined) throw new ApiError('NOT_FOUND');
            await requirePermissionInStores(
              db,
              { userId: acting.userId, tenantId, permissionId: PERM.userDeactivate },
              await targetStoreIds(db, targetUserId),
            );
            if (targetUserId !== acting.userId && (await holdsOwnerPowers(db, targetUserId))) {
              await requireTenantAdmin(db, acting, PERM.userDeactivate);
            }
            await db
              .updateTable('users')
              .set({ status: 'active' })
              .where('id', '=', targetUserId)
              .execute();
            await appendAudit(db, tenantId, {
              actorUserId: acting.userId,
              action: 'user.reactivated',
              entityType: 'user',
              entityId: targetUserId,
              before: { status: 'deactivated' },
              after: { status: 'active' },
              at: t,
            });
          });

          return c.json({ userId: targetUserId, status: 'active' });
        }),
      )

      // ---- POST /v1/users/:userId/pin-verifier (§5.4): device token + X-Acting-User ----
      .post('/:userId/pin-verifier', zJson(PutPinVerifierReq), (c) =>
        withIdentityErrors(c, async () => {
          const targetUserId = c.req.param('userId');
          if (!LOWERCASE_UUID.test(targetUserId)) throw new ApiError('NOT_FOUND');
          const body = c.req.valid('json');
          const t = deps.now();
          const tenantId = tenantIdFromContext(c);
          enforceUsersQuota(deps, tenantId, t);

          // pin-verifier is device-token only (§4.5: control session "—").
          if (c.get('device') === undefined) throw new ApiError('AUTH_TOKEN_INVALID');

          const applied = await withTenant(c, async (db) => {
            const acting = await resolveActingUser(c, db);
            const target = await db
              .selectFrom('users')
              .select(['id'])
              .where('id', '=', targetUserId)
              .executeTakeFirst();
            if (target === undefined) throw new ApiError('NOT_FOUND');

            // Own change → auth.pin_change, the same permission its pushed op declares (so a
            // deactivated user cannot set one either); reset of another user → auth.user_reset_pin
            // (+ the main_owner-target rule, §6.6, enforced here as defense-in-depth in addition to
            // the op-push validation task 07 owns).
            if (targetUserId === acting.userId) {
              await requirePermission(db, {
                userId: acting.userId,
                tenantId,
                storeId: acting.deviceStoreId,
                permissionId: PERM.pinChange,
              });
            } else {
              await requirePermission(db, {
                userId: acting.userId,
                tenantId,
                storeId: acting.deviceStoreId,
                permissionId: PERM.userResetPin,
              });
              for (const storeId of await targetStoreIds(db, targetUserId)) {
                if (
                  !(await hasPermission(db, {
                    userId: acting.userId,
                    tenantId,
                    storeId,
                    permissionId: PERM.userResetPin,
                  }))
                ) {
                  throw new PermissionDeniedError({
                    actorUserId: acting.userId,
                    permissionId: PERM.userResetPin,
                    scopeStoreId: storeId,
                    reason: 'restriction_violated',
                  });
                }
              }
              if (await holdsMainOwner(db, targetUserId)) {
                if (!(await holdsMainOwner(db, acting.userId)))
                  // Privileged-target restriction (§6.6) — the online endpoint mirror of the
                  // op-push rule task 07 owns (that path audits via device_anomalies). Declared
                  // here so the endpoint denial also lands in the FR-1045 trail (§7).
                  throw new PermissionDeniedError({
                    actorUserId: acting.userId,
                    permissionId: PERM.userResetPin,
                    scopeStoreId: acting.deviceStoreId,
                    reason: 'restriction_violated',
                  });
              }
            }

            // Greatest-asOf merge (§5.3): a stale POST is a no-op (idempotent convergence).
            const stored = await db
              .selectFrom('userPinVerifiers')
              .select(['asOfTimestamp', 'asOfDeviceId', 'asOfSeq'])
              .where('userId', '=', targetUserId)
              .executeTakeFirst();
            if (stored !== undefined) {
              const storedAsOf: CanonicalRef = {
                timestamp: Number(stored.asOfTimestamp),
                deviceId: stored.asOfDeviceId,
                seq: Number(stored.asOfSeq),
              };
              if (!isNewer(body.verifier.asOf, storedAsOf)) return false;
            }

            await writeVerifier(db, tenantId, targetUserId, body.verifier);
            await appendAudit(db, tenantId, {
              actorUserId: acting.userId,
              action: 'pin_verifier.replaced',
              entityType: 'pin_verifier',
              entityId: targetUserId,
              after: { verifierRef: body.verifierRef, verifier: body.verifier },
              at: t,
            });
            return true;
          });

          return c.json({ userId: targetUserId, applied });
        }),
      )
  );
}

/** Upsert a user's PIN verifier row from a validated PinVerifier. */
async function writeVerifier(
  db: TenantDb,
  tenantId: string,
  userId: string,
  verifier: PutPinVerifierReq['verifier'],
): Promise<void> {
  // The row shape lives in ONE place (task 208) — the harness lane seeds the same row to stand up the
  // emulator's on-device unlock, and an inline copy here would let the two drift silently.
  const row = buildPinVerifierRow(verifier, { userId, tenantId });
  await db
    .insertInto('userPinVerifiers')
    .values(row)
    .onConflict((oc) =>
      oc.column('userId').doUpdateSet({
        salt: row.salt,
        params: row.params,
        hash: row.hash,
        asOfTimestamp: row.asOfTimestamp,
        asOfDeviceId: row.asOfDeviceId,
        asOfSeq: row.asOfSeq,
      }),
    )
    .execute();
}

/** Whether `userId` holds a role named `main_owner`. */
async function holdsMainOwner(db: TenantDb, userId: string): Promise<boolean> {
  const row = await db
    .selectFrom('userRoles')
    .innerJoin('roles', 'roles.id', 'userRoles.roleId')
    .where('userRoles.userId', '=', userId)
    .where('roles.name', '=', 'main_owner')
    .select('userRoles.userId')
    .executeTakeFirst();
  return row !== undefined;
}
