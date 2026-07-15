// Sync sub-router (api/00 §1; wire protocol api/01-sync — task 16). STUB handlers: the full
// production middleware chain (bearerAuth → per-device limit → bodyLimit 1 MiB → gzip 10 MiB →
// zValidator) is wired at the app level and runs against these mounts, so the SEC-SYNC / CHAOS-10
// suites exercise the real transport here. Task 16 replaces the bodies and keeps them green.
import { Hono } from 'hono';

import { zPullRequest, zPushRequest, type PullResponse, type PushResponse } from '@bolusi/schemas';

import type { ServerDeps } from '../deps.js';
import type { AppEnv } from '../env.js';
import { zJson } from '../middleware/validator-hook.js';

export function createSyncRouter(deps: ServerDeps) {
  return new Hono<AppEnv>()
    .post('/push', zJson(zPushRequest), (c) => {
      deps.onStub?.('sync.push');
      const body: PushResponse = { results: [], serverTime: deps.now() };
      return c.json(body);
    })
    .post('/pull', zJson(zPullRequest), (c) => {
      deps.onStub?.('sync.pull');
      const body: PullResponse = { ops: [], nextCursor: 0, hasMore: false, serverTime: deps.now() };
      return c.json(body);
    });
}
