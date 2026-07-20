// Devices sub-router (api/02-auth §4.3 enroll, §5.2 bundle, §7 list/revoke/me). Bearer-guarded by
// the app chain; the per-endpoint auth matrix (§4.5) is enforced here.
import type { TenantDb } from '@bolusi/db-server';
import { Hono } from 'hono';
import type { Context } from 'hono';

import { resolveActingUser } from '../auth/acting-user.js';
import { requirePermission } from '../auth/permissions.js';
import { mintToken, sha256Hex } from '../crypto/index.js';
import type { ServerDeps } from '../deps.js';
import type { AppEnv, DevicePrincipal } from '../env.js';
import { ApiError } from '../errors.js';
import { appendAudit } from '../identity/audit.js';
import { PermissionDeniedError } from '../identity/denial-audit.js';
import { buildBundle, bundleEtag } from '../identity/bundle.js';
import { IdentityError, withIdentityErrors } from '../identity/errors.js';
import { PERM } from '../identity/permission-registry.js';
import { enforce, IDENTITY_LIMITS } from '../identity/rate-limits.js';
import { purgeExpiredIdempotency, runIdempotent } from '../identity/idempotency.js';
import { revokeDevice } from '../identity/revocation.js';
import { EnrollReq, type EnrollRes } from '../identity/schemas.js';
import { zJson } from '../middleware/validator-hook.js';
import { createWithTenant } from '../tenant.js';
import { tenantIdFromContext } from '../tenant.js';

const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;
const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Require a device-token principal; a control session on a device-only route → 401 (api/02-auth §4.5). */
function requireDevice(c: Context<AppEnv>): DevicePrincipal {
  const device = c.get('device');
  if (device === undefined) throw new ApiError('AUTH_TOKEN_INVALID');
  return device;
}

/** Throttled lastSeenAt write (api/02-auth §8): at most once per 5 min per device — no hot row. */
async function touchLastSeen(db: TenantDb, deviceId: string, now: number): Promise<void> {
  const row = await db
    .selectFrom('devices')
    .select(['lastSeenAt'])
    .where('id', '=', deviceId)
    .executeTakeFirst();
  if (row === undefined) return;
  const last = row.lastSeenAt === null ? null : Number(row.lastSeenAt);
  if (last === null || now - last >= LAST_SEEN_THROTTLE_MS) {
    await db
      .updateTable('devices')
      .set({ lastSeenAt: BigInt(now) })
      .where('id', '=', deviceId)
      .execute();
  }
}

export function createDevicesRouter(deps: ServerDeps) {
  const withTenant = createWithTenant(deps.forTenant);

  return (
    new Hono<AppEnv>()
      // ---- GET /v1/devices (§7.1): list the acting user's readable devices + anomaly counts ----
      .get('/', (c) =>
        withIdentityErrors(c, async () => {
          const t = deps.now();
          return withTenant(c, async (db) => {
            const acting = await resolveActingUser(c, db);
            const device = c.get('device');
            if (device !== undefined) await touchLastSeen(db, device.deviceId, t);

            // Stores where the acting user holds auth.device_read (tenant-wide grant ⇒ every store).
            const grants = await db
              .selectFrom('userRoles')
              .innerJoin('rolePermissions', 'rolePermissions.roleId', 'userRoles.roleId')
              .select('userRoles.storeId as storeId')
              .where('userRoles.userId', '=', acting.userId)
              .where('rolePermissions.permissionId', '=', PERM.deviceRead)
              .execute();
            const tenantWide = grants.some((g) => g.storeId === null);
            const readableStores = grants
              .map((g) => g.storeId)
              .filter((s): s is string => s !== null);
            // No auth.device_read grant in any store — a list-scope denial (security-guide §2.2).
            // Declared for the FR-1045 trail (§7); scope is null (the list spans the tenant).
            if (!tenantWide && readableStores.length === 0)
              throw new PermissionDeniedError({
                actorUserId: acting.userId,
                permissionId: PERM.deviceRead,
                scopeStoreId: null,
                reason: 'not_granted',
              });

            let query = db
              .selectFrom('devices')
              .select([
                'id',
                'name',
                'storeId',
                'status',
                'enrolledAt',
                'enrolledBy',
                'lastSyncAt',
                'lastSeenAt',
                'revokedAt',
                'revokedBy',
                'signingKeyPublic',
              ]);
            if (!tenantWide) query = query.where('storeId', 'in', readableStores);
            const rows = await query.orderBy('id').execute();

            const anomalies = await db
              .selectFrom('deviceAnomalies')
              .select(({ fn }) => [
                'deviceId',
                fn.count<string>('id').as('count'),
                fn.max('at').as('lastAt'),
              ])
              .groupBy('deviceId')
              .execute();
            const anomalyByDevice = new Map(
              anomalies.map((a) => [a.deviceId, { count: Number(a.count), lastAt: a.lastAt }]),
            );

            return c.json({
              devices: rows.map((d) => {
                const a = anomalyByDevice.get(d.id);
                return {
                  deviceId: d.id,
                  deviceName: d.name,
                  storeId: d.storeId,
                  status: d.status,
                  enrolledAt: Number(d.enrolledAt),
                  enrolledBy: d.enrolledBy,
                  lastSyncAt: d.lastSyncAt === null ? null : Number(d.lastSyncAt),
                  lastSeenAt: d.lastSeenAt === null ? null : Number(d.lastSeenAt),
                  revokedAt: d.revokedAt === null ? null : Number(d.revokedAt),
                  revokedBy: d.revokedBy,
                  signingKeyPublic: d.signingKeyPublic,
                  anomalyCount: a?.count ?? 0,
                  lastAnomalyAt:
                    a?.lastAt === undefined || a.lastAt === null ? null : Number(a.lastAt),
                };
              }),
            });
          });
        }),
      )

      // ---- POST /v1/devices/enroll (§4.3): control session + Idempotency-Key ----
      .post('/enroll', zJson(EnrollReq), (c) =>
        withIdentityErrors(c, async () => {
          const key = c.req.header('Idempotency-Key');
          if (key === undefined || key === '') {
            throw new ApiError('VALIDATION_FAILED', {
              issues: [
                {
                  path: ['Idempotency-Key'],
                  code: 'custom',
                  message: 'Idempotency-Key header is required',
                },
              ],
            });
          }
          const control = c.get('controlSession');
          if (control === undefined) throw new ApiError('PERMISSION_DENIED'); // enroll is control-session only (§4.5)

          const body = c.req.valid('json');
          const t = deps.now();
          const tenantId = control.tenantId;

          // §9: 20 enrollments / tenant / day.
          enforce(
            deps.identityRateStore.hit(
              `enroll:${tenantId}`,
              IDENTITY_LIMITS.enrollPerTenantDay.limit,
              IDENTITY_LIMITS.enrollPerTenantDay.windowMs,
              t,
            ),
          );

          const rawBody = JSON.stringify(body);
          const requestHash = sha256Hex(rawBody);

          // Purge expired idempotency rows in a SEPARATE, committed tx so it is not undone if this
          // enroll later fails validation (SEC-DEV-02: the 24 h purge bounds the token-retention).
          await deps.forTenant(tenantId, (db) => purgeExpiredIdempotency(db, tenantId, t));

          const result = await deps.forTenant(tenantId, (db) =>
            runIdempotent(db, {
              tenantId,
              endpoint: 'POST /v1/devices/enroll',
              key,
              requestHash,
              now: t,
              execute: async () => {
                // Permission: the session user holds auth.device_enroll scoped to the target store,
                // and the store exists in this tenant.
                const store = await db
                  .selectFrom('stores')
                  .select(['id', 'name'])
                  .where('id', '=', body.storeId)
                  .executeTakeFirst();
                if (store === undefined) throw new ApiError('PERMISSION_DENIED');
                await requirePermission(db, {
                  userId: control.userId,
                  tenantId,
                  storeId: body.storeId,
                  permissionId: PERM.deviceEnroll,
                });

                // deviceId unused.
                const dupId = await db
                  .selectFrom('devices')
                  .select('id')
                  .where('id', '=', body.deviceId)
                  .executeTakeFirst();
                if (dupId !== undefined) throw new IdentityError('ENROLL_DEVICE_ID_TAKEN');

                // pubkey unused.
                const dupKey = await db
                  .selectFrom('devices')
                  .select('id')
                  .where('signingKeyPublic', '=', body.devicePublicKeyB64)
                  .executeTakeFirst();
                if (dupKey !== undefined) throw new IdentityError('ENROLL_KEY_REUSED');

                // Register + mint.
                const deviceToken = mintToken('bdt_');
                await db
                  .insertInto('devices')
                  .values({
                    id: body.deviceId,
                    tenantId,
                    storeId: body.storeId,
                    kind: 'member',
                    name: body.deviceName,
                    signingKeyPublic: body.devicePublicKeyB64,
                    tokenHash: sha256Hex(deviceToken),
                    enrolledAt: BigInt(t),
                    enrolledBy: control.userId,
                    status: 'active',
                  })
                  .execute();

                await appendAudit(db, tenantId, {
                  actorUserId: control.userId,
                  action: 'device.enrolled',
                  entityType: 'device',
                  entityId: body.deviceId,
                  after: {
                    storeId: body.storeId,
                    deviceName: body.deviceName,
                    platform: body.platform,
                  },
                  at: t,
                });

                const tenant = await db
                  .selectFrom('tenants')
                  .select(['id', 'name'])
                  .where('id', '=', tenantId)
                  .executeTakeFirstOrThrow();
                const bundle = await buildBundle(db, tenantId, body.storeId);
                const etag = bundleEtag(bundle);
                const res: EnrollRes = {
                  deviceId: body.deviceId,
                  deviceToken,
                  tenant: { id: tenant.id, name: tenant.name },
                  store: { id: store.id, name: store.name },
                  settings: bundle.settings,
                  bundle,
                  bundleEtag: etag,
                  serverTime: t,
                };
                return { status: 201, body: res };
              },
            }),
          );

          if (result.replay) c.header('X-Idempotent-Replay', 'true');
          return c.json(result.body as EnrollRes, 201);
        }),
      )

      // ---- GET /v1/devices/me/bundle (§5.2): device token, conditional 304 ----
      .get('/me/bundle', (c) =>
        withIdentityErrors(c, async () => {
          const device = requireDevice(c);
          if (device.storeId === null) throw new ApiError('INTERNAL'); // system device has no bundle
          const t = deps.now();
          enforce(
            deps.identityRateStore.hit(
              `bundle:${device.deviceId}`,
              IDENTITY_LIMITS.bundlePerDeviceHour.limit,
              IDENTITY_LIMITS.bundlePerDeviceHour.windowMs,
              t,
            ),
          );
          return withTenant(c, async (db) => {
            await touchLastSeen(db, device.deviceId, t);
            const bundle = await buildBundle(db, device.tenantId, device.storeId as string);
            const etag = bundleEtag(bundle);
            if (c.req.header('If-None-Match') === etag) {
              c.header('ETag', etag);
              return c.body(null, 304);
            }
            c.header('ETag', etag);
            return c.json({ bundle, etag, serverTime: t });
          });
        }),
      )

      // ---- GET /v1/devices/me (§7.3): the confirm-then-wipe probe. A revoked token never reaches
      // here — verifyToken returns 401 DEVICE_REVOKED first, which IS the §7.3 confirm signal. ----
      .get('/me', (c) =>
        withIdentityErrors(c, async () => {
          const device = requireDevice(c);
          const t = deps.now();
          return withTenant(c, async (db) => {
            await touchLastSeen(db, device.deviceId, t);
            const row = await db
              .selectFrom('devices')
              .select(['id', 'name', 'storeId', 'status', 'enrolledAt', 'lastSyncAt', 'lastSeenAt'])
              .where('id', '=', device.deviceId)
              .executeTakeFirstOrThrow();
            return c.json({
              deviceId: row.id,
              deviceName: row.name,
              storeId: row.storeId,
              status: row.status,
              enrolledAt: Number(row.enrolledAt),
              lastSyncAt: row.lastSyncAt === null ? null : Number(row.lastSyncAt),
              lastSeenAt: row.lastSeenAt === null ? null : Number(row.lastSeenAt),
            });
          });
        }),
      )

      // ---- POST /v1/devices/:deviceId/revoke (§7.1): device+X-Acting-User or control session ----
      .post('/:deviceId/revoke', (c) =>
        withIdentityErrors(c, async () => {
          const deviceId = c.req.param('deviceId');
          if (!LOWERCASE_UUID.test(deviceId)) throw new ApiError('NOT_FOUND');
          const t = deps.now();
          const tenantId = tenantIdFromContext(c);
          enforce(
            deps.identityRateStore.hit(
              `revoke:${tenantId}`,
              IDENTITY_LIMITS.revokePerTenantHour.limit,
              IDENTITY_LIMITS.revokePerTenantHour.windowMs,
              t,
            ),
          );

          const outcome = await withTenant(c, async (db) => {
            const acting = await resolveActingUser(c, db);
            const target = await db
              .selectFrom('devices')
              .select(['id', 'storeId'])
              .where('id', '=', deviceId)
              .executeTakeFirst();
            if (target === undefined) throw new ApiError('NOT_FOUND');
            await requirePermission(db, {
              userId: acting.userId,
              tenantId,
              storeId: target.storeId,
              permissionId: PERM.deviceRevoke,
            });
            return revokeDevice(db, { tenantId, deviceId, revokedBy: acting.userId, now: t });
          });

          if (outcome.kind === 'not_found') throw new ApiError('NOT_FOUND');
          // Hooks fire post-commit, once, on the transition to revoked (task 20 registers socket-close).
          if (outcome.newlyRevoked) await deps.revocationHooks.fire({ deviceId, tenantId });
          return c.json(outcome.body);
        }),
      )
  );
}
