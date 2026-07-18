// The `ws` WebSocket server for the realtime upgrade (08 §2.4/§2.6). Created with
// `{ noServer: true }` and passed to `serve({ ..., websocket: { server } })` — @hono/node-server
// 2.x owns the HTTP `upgrade` handshake and links this server to the `upgradeWebSocket` helper the
// realtime route uses (NEVER the deprecated `@hono/node-ws`, 08 §2.6). One definition, shared by
// the boot entry (main.ts) and the real-socket integration test, so the payload cap can't drift.
import type { WebSocketServerLike } from '@hono/node-server';
import { WebSocketServer } from 'ws';

/**
 * Max bytes for a single inbound client frame. v0 clients send NOTHING (the channel is server→
 * client), so this is a pure memory backstop: `ws` rejects a frame above it (close 1009) before it
 * is buffered. Junk frames UNDER this are delivered to the route, which drops + counts them and
 * closes on a flood (SEC-RT-05). 64 KiB is far above any conceivable v0 client frame (there are
 * none) and far below anything that pressures a 2 GB host.
 */
export const REALTIME_MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * The `noServer` WebSocket server for `serve({ websocket: { server } })` (api/00 §12.1).
 *
 * Typed as node-server's minimal `WebSocketServerLike` (its `serve` parameter). The concrete
 * `ws.WebSocketServer` satisfies it structurally at runtime; the one nit is `noServer`'s optionality
 * (`ws` types it `boolean | undefined`, the Like type requires `boolean`), so the cast is confined to
 * this single boundary. node-server's own runtime guard re-checks `noServer === true`.
 */
export function makeRealtimeWebSocketServer(): WebSocketServerLike {
  return new WebSocketServer({
    noServer: true,
    maxPayload: REALTIME_MAX_PAYLOAD_BYTES,
  }) as unknown as WebSocketServerLike;
}
