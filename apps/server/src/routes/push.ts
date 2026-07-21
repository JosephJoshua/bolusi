// Push-token registration sub-router — `POST /v1/push/tokens` (api/04-push §2). Replaces task 12's
// stub. Device-bearer only (the app-level bearerAuth, task 12); the acting user rides in the
// OPTIONAL `X-Acting-User` header (api/00 §3) — present post-login (server stamps `user_id`), omitted
// pre-login (server stamps `user_id = null`, §2). Upsert keyed by `device_id` (idx_push_tokens_device):
// one token per install, idempotent by construction — a byte-identical replay converges on the same
// row, and an `Idempotency-Key` header is ignored (§2). SECURITY SURFACE: a token binds to the
// AUTHENTICATED device (body `deviceId` must equal the bearer's device → else 403) and its tenant
// (forTenant/RLS), so a device can never register a token for another device or tenant.
import { Hono } from 'hono';

import { resolveActingUser } from '../auth/acting-user.js';
import { isUniqueViolation } from '../db-errors.js';
import type { ServerDeps } from '../deps.js';
import type { AppEnv } from '../env.js';
import { ApiError, respondError } from '../errors.js';
import { withIdentityErrors } from '../identity/errors.js';
import { enforce } from '../identity/rate-limits.js';
import { zJson } from '../middleware/validator-hook.js';
import {
  PUSH_REGISTER_PER_DAY,
  zPushTokenRegisterBody,
  type PushTokenRegisterResponse,
} from '../push/schemas.js';
import { createWithTenant } from '../tenant.js';
import { uuidv7 } from '../uuidv7.js';

export function createPushRouter(deps: ServerDeps) {
  const withTenant = createWithTenant(deps.forTenant);

  return new Hono<AppEnv>().post('/tokens', zJson(zPushTokenRegisterBody), (c) =>
    withIdentityErrors(c, async () => {
      const device = c.get('device');
      const body = c.req.valid('json');

      // The token binds to the AUTHENTICATED device (api/04-push §2). A body deviceId that is not the
      // bearer's device is a cross-device registration attempt → 403, before any DB work.
      if (body.deviceId !== device.deviceId) {
        return respondError(c, 'PERMISSION_DENIED');
      }

      // 30 registrations/day/device (api/04-push §2). Fixed-window; a breach → 429 with Retry-After.
      const now = deps.now();
      enforce(
        deps.identityRateStore.hit(
          `push:register:${device.deviceId}`,
          PUSH_REGISTER_PER_DAY.limit,
          PUSH_REGISTER_PER_DAY.windowMs,
          now,
        ),
      );

      return withTenant(c, async (db) => {
        // Acting user is OPTIONAL for push (§2). Present → validate through the shared trust model
        // (resolveActingUser: exists in THIS tenant + usable on this device, else ACTING_USER_INVALID)
        // and stamp it. Absent → `user_id = null` (pre-login registration). "Last registrant wins"
        // (§2): the value written is whoever registered THIS time, filling a previously-null id on a
        // later authenticated registration.
        const claimed = c.req.header('X-Acting-User');
        const userId =
          claimed !== undefined && claimed !== '' ? (await resolveActingUser(c, db)).userId : null;

        // "Last registrant wins" (api/04-push §2): `expo_push_token` is a GLOBAL UNIQUE, so a token
        // can belong to at most one device. If ANOTHER device in this tenant already holds it,
        // ownership TRANSFERS here — re-point it by first releasing the prior holder, then upserting
        // our own row. This DELETE is RLS-scoped to the registrant's tenant (forTenant; 10-db §6), so
        // it touches only within-tenant rows and never reaches across tenants. The `deviceId != …`
        // guard leaves our own existing row (idempotent replay / token rotation) for the upsert below.
        await db
          .deleteFrom('pushTokens')
          .where('expoPushToken', '=', body.expoPushToken)
          .where('deviceId', '!=', device.deviceId)
          .execute();

        try {
          await db
            .insertInto('pushTokens')
            .values({
              id: uuidv7(now),
              tenantId: device.tenantId,
              deviceId: device.deviceId,
              userId,
              expoPushToken: body.expoPushToken,
              updatedAt: now,
            })
            .onConflict((oc) =>
              oc.column('deviceId').doUpdateSet({
                expoPushToken: body.expoPushToken,
                userId,
                updatedAt: now,
              }),
            )
            .execute();
        } catch (err) {
          // The only unique violation reachable now is the GLOBAL `expo_push_token` UNIQUE held by a
          // row in ANOTHER tenant: the within-tenant holder was just released, and the `device_id`
          // conflict is absorbed by onConflict. RLS hides that row (bolusi_app is NOBYPASSRLS), so we
          // CANNOT transfer it without breaking tenant isolation — fail closed (never 500, never
          // reveal the other tenant), rolling back this tx. Reuses task 114's shared 23505 detector
          // (CLAUDE.md §2.8) — no fourth copy.
          if (isUniqueViolation(err)) throw new ApiError('PERMISSION_DENIED');
          throw err;
        }

        const response: PushTokenRegisterResponse = { deviceId: device.deviceId, updatedAt: now };
        return c.json(response);
      });
    }),
  );
}
