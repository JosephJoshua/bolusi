// Users sub-router (api/02-auth §5.4). Bearer-guarded; the §4.5 matrix + the §5.4 anti-escalation
// rules are enforced here against the server directory.
import { compareCanonicalOrder } from '@bolusi/core';
import type { TenantDb } from '@bolusi/db-server';
import { Hono } from 'hono';

import { resolveActingUser } from '../auth/acting-user.js';
import { countActiveTenantAdmins, isTenantAdmin, requirePermission } from '../auth/permissions.js';
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

            // Roles must exist in this tenant. Tenant-scoped roles create a tenant-wide grant, which
            // (tenant-grant rule §5.4.2) requires the creator to be a tenant admin — this is what
            // stops a store_owner from minting a main_owner.
            const roles = await db
              .selectFrom('roles')
              .select(['id', 'scopeType'])
              .where('id', 'in', body.roleIds)
              .execute();
            if (roles.length !== body.roleIds.length) throw new ApiError('PERMISSION_DENIED');
            const grantsTenantWide = roles.some((r) => r.scopeType === 'tenant');
            if (grantsTenantWide && !(await isTenantAdmin(db, acting.userId))) {
              // §5.4.2 tenant-grant rule — a handler-declared restriction (not a plain
              // requirePermission miss): only a tenant admin may mint a tenant-wide role, so a
              // store_owner cannot create a main_owner. Declared for the FR-1045 trail (§7).
              throw new PermissionDeniedError({
                actorUserId: acting.userId,
                permissionId: TENANT_ADMIN_PERMISSION,
                scopeStoreId: null,
                reason: 'restriction_violated',
              });
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
            for (const role of roles) {
              if (role.scopeType === 'tenant') {
                await db
                  .insertInto('userRoles')
                  .values({ tenantId, userId: newUserId, roleId: role.id, storeId: null })
                  .execute();
              } else {
                for (const storeId of body.storeIds) {
                  await db
                    .insertInto('userRoles')
                    .values({ tenantId, userId: newUserId, roleId: role.id, storeId })
                    .execute();
                }
              }
            }
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
            for (const storeId of scopeStores) {
              await requirePermission(db, {
                userId: acting.userId,
                tenantId,
                storeId,
                permissionId: PERM.userEdit,
              });
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

            await appendAudit(db, tenantId, {
              actorUserId: acting.userId,
              action: 'user.updated',
              entityType: 'user',
              entityId: targetUserId,
              after: { name: body.name, storeIds: body.storeIds, photoMediaId: body.photoMediaId },
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

            for (const storeId of await targetStoreIds(db, targetUserId)) {
              await requirePermission(db, {
                userId: acting.userId,
                tenantId,
                storeId,
                permissionId: PERM.userDeactivate,
              });
            }

            // LAST_ADMIN_PROTECTED (§5.4.4): deactivating the sole active tenant admin → 409. Server
            // endpoint check only — no projection guard, no Conflict record.
            if (await isTenantAdmin(db, targetUserId)) {
              const remaining = await countActiveTenantAdmins(db, { excludeUserId: targetUserId });
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
            for (const storeId of await targetStoreIds(db, targetUserId)) {
              await requirePermission(db, {
                userId: acting.userId,
                tenantId,
                storeId,
                permissionId: PERM.userDeactivate,
              });
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

            // Own change → no permission; reset of another user → auth.user_reset_pin (+ the
            // main_owner-target rule, §6.6, enforced here as defense-in-depth in addition to the
            // op-push validation task 07 owns).
            if (targetUserId !== acting.userId) {
              await requirePermission(db, {
                userId: acting.userId,
                tenantId,
                storeId: acting.deviceStoreId,
                permissionId: PERM.userResetPin,
              });
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
  const row = {
    userId,
    tenantId,
    algo: 'argon2id' as const,
    salt: verifier.saltB64,
    params: { m: verifier.mKiB, t: verifier.t, p: verifier.p } as never,
    hash: verifier.hashB64,
    asOfTimestamp: BigInt(verifier.asOf.timestamp),
    asOfDeviceId: verifier.asOf.deviceId,
    asOfSeq: BigInt(verifier.asOf.seq),
  };
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
