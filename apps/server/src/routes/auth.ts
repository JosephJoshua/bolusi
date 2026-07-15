// Auth/identity sub-router (api/00 §1; flows api/02-auth — task 13). STUB.
// `POST /v1/auth/login` is the ONLY bearer-exempt route (api/00 §1, §3): the app-level chain
// skips bearerAuth for it and applies the per-IP limiter instead. Its real credential body
// schema is api/02-auth's; the skeleton keeps it unvalidated so no invented schema leaks in.
import { Hono } from 'hono';

import type { ServerDeps } from '../deps.js';
import type { AppEnv } from '../env.js';

export function createAuthRouter(deps: ServerDeps) {
  return new Hono<AppEnv>()
    .post('/login', (c) => {
      deps.onStub?.('auth.login');
      return c.json({ stub: 'auth.login' } as const);
    })
    .post('/password', (c) => {
      deps.onStub?.('auth.password');
      return c.json({ stub: 'auth.password' } as const);
    });
}
