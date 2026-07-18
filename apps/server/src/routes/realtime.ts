// Realtime sub-router (api/00 §1, §12). Replaces task 12's stub with the two transports:
//   GET /v1/realtime      — WS upgrade via `upgradeWebSocket` from @hono/node-server 2.x (+ `ws`,
//                           wired in main.ts as `serve({ websocket: { server } })`). NEVER
//                           `@hono/node-ws` (08 §2.6).
//   GET /v1/realtime/sse  — SSE fallback via `streamSSE` (hono/streaming).
//
// AUTH IS AT THE UPGRADE, before any socket (api/00 §12.1, security-guide §9.1). The app-level
// chain (app.ts) gives these routes the REDUCED middleware set (§13 last line): requestId +
// server-time + access-log + bearerAuth + the realtime per-device limit (10/min, §11), and NO
// compress / body middleware (compress is excluded because `upgradeWebSocket` mutates response
// headers internally). So an invalid / missing / revoked token throws in `bearerAuth` and
// @hono/node-server rejects the HTTP upgrade with a plain `401` — the socket is never established
// and a query-string token is simply never read (SEC-RT-01). This module runs only AFTER auth
// succeeded and `c.get('device')` is the authenticated device (§3).
//
// The transports carry POKES ONLY. Every frame is the hub's frozen `sync.poke` (SEC-RT-03); the
// hub's scope routing keeps a device deaf to other tenants/stores (SEC-RT-04); v0 ignores every
// client frame (SEC-RT-05). None of this is load-bearing (FR-1146) — it triggers pulls.
import { streamSSE } from 'hono/streaming';
import { upgradeWebSocket } from '@hono/node-server';
import { Hono } from 'hono';
import type { WebSocket as WsWebSocket } from 'ws';

import type { ServerDeps } from '../deps.js';
import type { AppEnv, DevicePrincipal } from '../env.js';
import {
  SSE_HEARTBEAT_INTERVAL_MS,
  SYNC_POKE_FRAME,
  WS_PING_INTERVAL_MS,
  type HubRegistration,
  type RealtimeConnection,
} from '../realtime/hub.js';

/** Build the hub-facing connection over a live `ws` socket (WS leg). */
function makeWsConnection(rawWs: WsWebSocket, device: DevicePrincipal): RealtimeConnection {
  return {
    deviceId: device.deviceId,
    tenantId: device.tenantId,
    storeId: device.storeId,
    heartbeatIntervalMs: WS_PING_INTERVAL_MS,
    tracksLiveness: true,
    emitPoke() {
      if (rawWs.readyState === rawWs.OPEN) rawWs.send(SYNC_POKE_FRAME);
    },
    probe() {
      if (rawWs.readyState === rawWs.OPEN) rawWs.ping();
    },
    close() {
      try {
        rawWs.close(1000);
      } catch {
        rawWs.terminate();
      }
    },
  };
}

export function createRealtimeRouter(deps: ServerDeps) {
  const hub = deps.realtimeHub;

  // Task 16's push handler publishes the accepted ops' pull scopes into `pokeHub` after commit;
  // fan them out here (api/00 §12.1). This IS the "whichever of 16/20 lands second" one-line wiring
  // named in the task — the authoritative data path stays the signed pull, this only says "pull".
  deps.pokeHub.subscribe((scope) => hub.pokeAccepted(scope));

  // SEC-RT-02: a device revocation closes its live socket(s) at once. The hook fires post-commit
  // from the revoke handler (real /v1/devices/:id/revoke wiring is task 13); the hook + its test
  // live here. Reconnect is then refused at auth (verifyToken → DEVICE_REVOKED → 401).
  deps.revocationHooks.register((ctx) => {
    hub.closeForDevice(ctx.deviceId);
  });

  return new Hono<AppEnv>()
    .get(
      '/',
      upgradeWebSocket(
        (c) => {
          const device = c.get('device') as DevicePrincipal | undefined;
          let registration: HubRegistration | null = null;
          return {
            onOpen(_evt, ws) {
              // node-server's `ws.raw` is the concrete `ws.WebSocket` at runtime; its type is the
              // minimal `WebSocketLike` (no ping/pong/terminate), so the cast is at this one seam.
              const rawWs = ws.raw as unknown as WsWebSocket | undefined;
              // Realtime is device-token only. A control session (no `device`) or a missing raw
              // socket cannot subscribe — close with a policy-violation code.
              if (device === undefined || rawWs === undefined) {
                ws.close(1008, 'device token required');
                return;
              }
              registration = hub.register(makeWsConnection(rawWs, device));
              rawWs.on('pong', () => registration?.notifyPong());
            },
            // v0 ignores ALL client frames (api/00 §12.1). Count them so a flood is closable
            // (SEC-RT-05); never parse or act on them — the channel is server→client only.
            onMessage() {
              registration?.notifyClientMessage();
            },
            onClose() {
              registration?.dispose();
            },
            onError() {
              registration?.dispose();
            },
          };
        },
        {
          // A per-socket error must not crash the server (SEC-RT-05); realtime is best-effort.
          onError: () => {
            /* swallowed — a broken socket costs only pull latency (api/01-sync §8) */
          },
        },
      ),
      // Non-upgrade GET probe: the reduced chain reaches a 200 here (keeps task 12's middleware /
      // rate-limit assertions green). A real WS client sends the `Upgrade` header and never reaches
      // this handler; `upgradeWebSocket` returns the upgrade response and short-circuits.
      (c) => c.json({ realtime: 'ws' } as const),
    )
    .get('/sse', (c) => {
      const device = c.get('device') as DevicePrincipal | undefined;
      return streamSSE(c, async (stream) => {
        if (device === undefined) {
          await stream.close();
          return;
        }
        let eventId = 0;
        let releaseClose: () => void = () => {};
        const closed = new Promise<void>((resolve) => {
          releaseClose = resolve;
        });
        const connection: RealtimeConnection = {
          deviceId: device.deviceId,
          tenantId: device.tenantId,
          storeId: device.storeId,
          heartbeatIntervalMs: SSE_HEARTBEAT_INTERVAL_MS,
          tracksLiveness: false,
          emitPoke() {
            eventId += 1;
            // `data` is the literal `{}` — no business value can ride this leg (SEC-RT-03).
            void stream.writeSSE({ event: 'sync.poke', data: '{}', id: String(eventId) });
          },
          probe() {
            // SSE keepalive is a comment line (api/00 §12.2) — ignored by the EventSource parser.
            void stream.write(': hb\n\n');
          },
          close() {
            releaseClose();
          },
        };
        const registration = hub.register(connection);
        // Client disconnect aborts the stream — drop the registration so the registry returns to
        // baseline (no leaks) and stop the keepalive.
        stream.onAbort(() => {
          registration.dispose();
          releaseClose();
        });
        await closed;
        registration.dispose();
        if (!stream.closed && !stream.aborted) {
          await stream.close();
        }
      });
    });
}
