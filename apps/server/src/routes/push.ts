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
import type { ServerDeps } from '../deps.js';
import type { AppEnv } from '../env.js';
import { respondError } from '../errors.js';
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

        const response: PushTokenRegisterResponse = { deviceId: device.deviceId, updatedAt: now };
        return c.json(response);
      });
    }),
  );
}
