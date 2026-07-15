// Users sub-router (api/00 §1; api/02-auth §5 — task 13). STUB. Bearer-guarded by the app chain.
import { Hono } from 'hono';

import type { ServerDeps } from '../deps.js';
import type { AppEnv } from '../env.js';

export function createUsersRouter(deps: ServerDeps) {
  return new Hono<AppEnv>()
    .post('/', (c) => {
      deps.onStub?.('users.create');
      return c.json({ stub: 'users.create' } as const);
    })
    .patch('/:id', (c) => {
      deps.onStub?.('users.update');
      return c.json({ stub: 'users.update' } as const);
    });
}
