// Push-token sub-router (api/00 §1; api/04-push — task 21). STUB. Bearer-guarded.
import { Hono } from 'hono';

import type { ServerDeps } from '../deps.js';
import type { AppEnv } from '../env.js';

export function createPushRouter(deps: ServerDeps) {
  return new Hono<AppEnv>().post('/tokens', (c) => {
    deps.onStub?.('push.tokens');
    return c.json({ stub: 'push.tokens' } as const);
  });
}
