// Devices sub-router (api/00 §1; api/02-auth §7 — task 13). STUB. Bearer-guarded by the
// app-level chain. `enroll` also requires an Idempotency-Key (§8.2) — that store is task 13.
import { Hono } from 'hono';

import type { ServerDeps } from '../deps.js';
import type { AppEnv } from '../env.js';

export function createDevicesRouter(deps: ServerDeps) {
  return new Hono<AppEnv>()
    .get('/', (c) => {
      deps.onStub?.('devices.list');
      return c.json({ stub: 'devices.list' } as const);
    })
    .post('/enroll', (c) => {
      deps.onStub?.('devices.enroll');
      return c.json({ stub: 'devices.enroll' } as const);
    })
    .get('/me', (c) => {
      deps.onStub?.('devices.me');
      return c.json({ stub: 'devices.me' } as const);
    });
}
