// Integrated QRIS (qris/service.ts). Devices, as the signed-in person (X-Acting-User), under /v1:
//
//   GET    /v1/money/qris/accounts              the connected accounts this store can use
//   PUT    /v1/money/qris/accounts/:accountId   connect one with its Xendit secret key
//   DELETE /v1/money/qris/accounts/:accountId   back to QRIS by hand
//   POST   /v1/money/qris/charges               a QR for one payment
//   GET    /v1/money/qris/charges/:id           paid yet?
//   POST   /v1/money/qris/charges/:id/simulate  test mode: pay it
//
// And Xendit, outside /v1 with no bearer token:
//
//   POST   /xendit/qr/:tenantId/:accountId      `qr.payment` for one connected account
//
// The callback is the one place a tenant id comes from a path rather than a bearer (tenant.ts): it
// is authenticated by the account's callback token, compared against the hash stored in that
// tenant's own row, and nothing is recorded until Xendit confirms the payment to the account's key.
// Xendit retries anything but a 2xx, so a payment the server could not record yet gets a 503.
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

import {
  zQrisChargeBody,
  zQrisConnectBody,
  zUuid,
  type QrisCharge,
  type QrisConnection,
  type QrisConnectionsResponse,
} from '@bolusi/schemas';

import { resolveActingUser, type ActingUser } from '../auth/acting-user.js';
import type { ServerDeps } from '../deps.js';
import type { AppEnv } from '../env.js';
import { ApiError } from '../errors.js';
import { zJson } from '../middleware/validator-hook.js';
import {
  chargeStatus,
  connectAccount,
  createCharge,
  disconnectAccount,
  handleCallback,
  listConnections,
  simulateCharge,
} from '../qris/service.js';
import { tenantIdFromContext } from '../tenant.js';

function idParam(c: Context<AppEnv>, name: string): string {
  const parsed = zUuid.safeParse(c.req.param(name));
  if (!parsed.success) throw new ApiError('NOT_FOUND');
  return parsed.data;
}

/** Charges are made at a store's counter: a device, never an owner's control session. */
function deviceOf(c: Context<AppEnv>) {
  const device = c.get('device');
  if (device === undefined) throw new ApiError('PERMISSION_DENIED');
  return device;
}

export function createQrisRouter(deps: ServerDeps) {
  const acting = (c: Context<AppEnv>): Promise<ActingUser> =>
    deps.forTenant(tenantIdFromContext(c), (db) => resolveActingUser(c, db));

  return new Hono<AppEnv>()
    .get('/accounts', async (c) => {
      const user = await acting(c);
      const connections = await deps.forTenant(user.tenantId, (db) => listConnections(db, user));
      const body: QrisConnectionsResponse = { connections };
      return c.json(body);
    })
    .put('/accounts/:accountId', zJson(zQrisConnectBody), async (c) => {
      const user = await acting(c);
      const body: QrisConnection = await connectAccount(
        deps,
        user,
        idParam(c, 'accountId'),
        c.req.valid('json').secretKey,
      );
      return c.json(body);
    })
    .delete('/accounts/:accountId', async (c) => {
      const user = await acting(c);
      await disconnectAccount(deps, user, idParam(c, 'accountId'));
      return c.body(null, 204);
    })
    .post('/charges', zJson(zQrisChargeBody), async (c) => {
      const device = deviceOf(c);
      const user = await acting(c);
      const body: QrisCharge = await createCharge(deps, user, device, c.req.valid('json'));
      return c.json(body);
    })
    .get('/charges/:id', async (c) => {
      deviceOf(c);
      const user = await acting(c);
      const body: QrisCharge = await chargeStatus(deps, user, idParam(c, 'id'));
      return c.json(body);
    })
    .post('/charges/:id/simulate', async (c) => {
      deviceOf(c);
      const user = await acting(c);
      const body: QrisCharge = await simulateCharge(deps, user, idParam(c, 'id'));
      return c.json(body);
    });
}

const zCallbackParams = z.object({ tenantId: zUuid, accountId: zUuid });

export function createXenditCallbackRouter(deps: ServerDeps) {
  return new Hono<AppEnv>().post(
    '/qr/:tenantId/:accountId',
    bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.body(null, 413) }),
    async (c) => {
      const params = zCallbackParams.safeParse(c.req.param());
      if (!params.success) return c.body(null, 401);
      const body: unknown = await c.req.json().catch(() => null);
      const outcome = await handleCallback(
        deps,
        params.data.tenantId,
        params.data.accountId,
        c.req.header('x-callback-token'),
        body,
      );
      if (outcome === 'unauthorized') return c.body(null, 401);
      if (outcome === 'retry') return c.body(null, 503);
      return c.body(null, 200);
    },
  );
}
