// Boot entry (08 §5.1 `pnpm dev`). Reads config once (security-guide §10), builds the app with
// the production per-IP key source (node-server's getConnInfo — a real socket address, not the
// testable X-Forwarded-For fallback), and serves via @hono/node-server.
import { assertRowSecurityRole } from '@bolusi/db-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { defaultClientIp } from './deps.js';
import type { AppEnv } from './env.js';
import { requireMediaStorageDir } from './media/config.js';
import { serverCryptoPort } from './oplog/index.js';
import { pushPortFromConfig } from './push/expo-transport.js';
import { serveWithRealtime } from './realtime/serve.js';
import { systemKeyStoreFromConfig } from './sync/system-key-store.js';

const config = loadConfig();
requireMediaStorageDir();

// Tenant isolation is RLS, and a superuser or BYPASSRLS login skips it even under FORCE. Refuse to
// listen on such a DATABASE_URL (10-db §6.3: the server connects as bolusi_app).
await assertRowSecurityRole();

// PUSH DELIVERY (task 134; api/04-push §7, 08 §8). This is the ONE production injection point for
// the push sender: build the real `ExpoPushSender` from `EXPO_ACCESS_TOKEN` and inject it, so a
// running server actually delivers what `POST /v1/push/tokens` collects. UNLIKE `SYSTEM_KEY_DIR`,
// an absent token is NOT a graceful "push off" — `pushPortFromConfig` THROWS here, before `serve`,
// because a silent push port is the exact defect this task removed. resolveDeps's field default
// (`unconfiguredPushPort`) exists only for the type-derivation `createApp()` and tests (fakes).
const pushPort = pushPortFromConfig(config);

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
  pushPort,
  ...(systemKeyStore === undefined ? {} : { systemKeyStore }),
});

// Attaches the `ws` server for the GET /v1/realtime upgrade (api/00 §12.1).
serveWithRealtime({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`@bolusi/server listening on :${info.port}`);
});
