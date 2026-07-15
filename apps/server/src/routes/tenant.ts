// Tenant-settings sub-router (api/00 §1; api/02-auth — task 13). STUB. Bearer-guarded.
import { Hono } from 'hono';

import type { ServerDeps } from '../deps.js';
import type { AppEnv } from '../env.js';

export function createTenantRouter(deps: ServerDeps) {
  return new Hono<AppEnv>().patch('/settings', (c) => {
    deps.onStub?.('tenant.settings');
    return c.json({ stub: 'tenant.settings' } as const);
  });
}
