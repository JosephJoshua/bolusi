// Sync sub-router (api/00 §1; wire protocol api/01-sync — task 16). The production middleware chain
// (bearerAuth → per-device limit → bodyLimit 1 MiB → gzip 10 MiB → zValidator) is wired at the app
// level (app.ts) and runs against these mounts. The handlers delegate to the push/pull modules; the
// router stays a CHAINED definition so `AppType` RPC inference (api/00 §14) keeps working.
import { Hono } from 'hono';

import { zPullRequest, zPushRequest, type PullResponse, type PushResponse } from '@bolusi/schemas';

import type { ServerDeps } from '../deps.js';
import type { AppEnv } from '../env.js';
import { zJson } from '../middleware/validator-hook.js';
import { runPull } from '../sync/pull.js';
import { runPush } from '../sync/push.js';

export function createSyncRouter(deps: ServerDeps) {
  return new Hono<AppEnv>()
    .post('/push', zJson(zPushRequest), async (c) => {
      deps.onStub?.('sync.push');
      const device = c.get('device');
      const body: PushResponse = await runPush(
        {
          forTenant: deps.forTenant,
          crypto: deps.serverCrypto,
          now: deps.now,
          newId: deps.newOpLogId,
          registry: deps.opRegistry,
          projections: deps.projections,
          pokeHub: deps.pokeHub,
        },
        { deviceId: device.deviceId, tenantId: device.tenantId },
        c.req.valid('json'),
      );
      return c.json(body);
    })
    .post('/pull', zJson(zPullRequest), async (c) => {
      deps.onStub?.('sync.pull');
      const device = c.get('device');
      const body: PullResponse = await runPull(
        { forTenant: deps.forTenant, now: deps.now },
        { deviceId: device.deviceId, tenantId: device.tenantId, storeId: device.storeId },
        c.req.valid('json'),
      );
      return c.json(body);
    });
}
