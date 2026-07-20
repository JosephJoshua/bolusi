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
import { serverCryptoPort } from './oplog/index.js';
import { makeRealtimeWebSocketServer } from './realtime/serve.js';
import { systemKeyStoreFromConfig } from './sync/system-key-store.js';

const config = loadConfig();

// DEPLOYMENT CONVENTION (task 78): set `SYSTEM_KEY_DIR` to the directory holding the
// `system-device-<tenantId>.key` files `provision-tenant` writes (base64 Ed25519 secret) to ENABLE
// conflict detection (01 §8.2); UNSET = detection OFF (the honest v0 default — pushes still succeed,
// nothing is detected). This is the ONE production injection point: with a dir set this builds a
// DirectorySystemKeyStore and `resolveDeps` wires `detectConflicts` over it; unset ⇒ undefined ⇒ no
// detection (deps.ts / conflict-wiring.ts header). A tenant whose key is missing/malformed when the
// dir IS set fails LOUD at its first real collision, never silently off (sync/system-key-store.ts).
const systemKeyStore = systemKeyStoreFromConfig(config, serverCryptoPort);

function productionClientIp(c: Context<AppEnv>): string {
  try {
    const address = getConnInfo(c).remote.address;
    if (address !== undefined && address !== '') return address;
  } catch {
    /* getConnInfo needs the node-server binding — fall back to the header source. */
  }
  return defaultClientIp(c);
}

const app = createApp({
  clientIp: productionClientIp,
  ...(systemKeyStore === undefined ? {} : { systemKeyStore }),
});

// The `ws` server for the GET /v1/realtime upgrade (api/00 §12.1). @hono/node-server owns the HTTP
// `upgrade` handshake and links this `{ noServer: true }` server to the route's `upgradeWebSocket`.
const websocket = { server: makeRealtimeWebSocketServer() };

serve({ fetch: app.fetch, port: config.port, websocket }, (info) => {
  console.log(`@bolusi/server listening on :${info.port}`);
});
