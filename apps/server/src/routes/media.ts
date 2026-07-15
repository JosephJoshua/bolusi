// Media sub-router (api/00 §1; wire protocol api/03-media — task 19). STUB. Bearer-guarded.
// Media chunk uploads are raw binary: the gzip middleware is NOT mounted on media routes and a
// gzip chunk → 415 (api/03-media §7) — that wiring lands with the real handlers in task 19.
import { Hono } from 'hono';

import type { ServerDeps } from '../deps.js';
import type { AppEnv } from '../env.js';

export function createMediaRouter(deps: ServerDeps) {
  return new Hono<AppEnv>()
    .post('/:id/init', (c) => {
      deps.onStub?.('media.init');
      return c.json({ stub: 'media.init' } as const);
    })
    .put('/:id/chunks/:index', (c) => {
      deps.onStub?.('media.chunk');
      return c.json({ stub: 'media.chunk' } as const);
    })
    .get('/:id', (c) => {
      deps.onStub?.('media.get');
      return c.json({ stub: 'media.get' } as const);
    });
}
