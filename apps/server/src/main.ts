// Boot entry (08 §5.1 `pnpm dev`). Reads config once (security-guide §10), builds the app with
// the production per-IP key source (node-server's getConnInfo — a real socket address, not the
// testable X-Forwarded-For fallback), and serves via @hono/node-server.
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { defaultClientIp } from './deps.js';
import type { AppEnv } from './env.js';

const config = loadConfig();

function productionClientIp(c: Context<AppEnv>): string {
  try {
    const address = getConnInfo(c).remote.address;
    if (address !== undefined && address !== '') return address;
  } catch {
    /* getConnInfo needs the node-server binding — fall back to the header source. */
  }
  return defaultClientIp(c);
}

const app = createApp({ clientIp: productionClientIp });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`@bolusi/server listening on :${info.port}`);
});
