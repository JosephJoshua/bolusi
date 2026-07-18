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
import { makeRealtimeWebSocketServer } from './realtime/serve.js';

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

// The `ws` server for the GET /v1/realtime upgrade (api/00 §12.1). @hono/node-server owns the HTTP
// `upgrade` handshake and links this `{ noServer: true }` server to the route's `upgradeWebSocket`.
const websocket = { server: makeRealtimeWebSocketServer() };

serve({ fetch: app.fetch, port: config.port, websocket }, (info) => {
  console.log(`@bolusi/server listening on :${info.port}`);
});
