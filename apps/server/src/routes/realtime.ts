// Realtime sub-router (api/00 §1, §12; WS/SSE impl — task 20). STUB GET handlers.
// The app-level chain gives these routes the REDUCED middleware set (§13 last line: steps 1–3
// minus compress, plus bearerAuth + per-device limit; NO body middleware, NO compress — the
// latter because upgradeWebSocket mutates headers internally, §12.1). Task 20 replaces these
// stubs with upgradeWebSocket / streamSSE; the reduced chain is already correct for them.
import { Hono } from 'hono';

import type { ServerDeps } from '../deps.js';
import type { AppEnv } from '../env.js';

export function createRealtimeRouter(deps: ServerDeps) {
  return new Hono<AppEnv>()
    .get('/', (c) => {
      deps.onStub?.('realtime.ws');
      return c.json({ stub: 'realtime.ws' } as const);
    })
    .get('/sse', (c) => {
      deps.onStub?.('realtime.sse');
      return c.json({ stub: 'realtime.sse' } as const);
    });
}
