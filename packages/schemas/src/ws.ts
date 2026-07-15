// Realtime message schemas (api/00 §12.1–12.2). hc's $ws() does NOT type socket
// payloads — these Zod schemas are the single wire definition (api/00 §14).
import { z } from 'zod';

/**
 * WS/SSE frame shape `{ type, payload }` — server→client only in v0. Tolerant:
 * clients IGNORE frames whose `type` they don't know (api/00 §4/§12.1), so an
 * unknown type must still parse at frame level.
 */
export const zWsFrame = z.object({
  type: z.string(),
  payload: z.looseObject({}),
});
export type WsFrame = z.infer<typeof zWsFrame>;

/**
 * `sync.poke` (api/00 §12.1): payload is exactly `{}` — a non-empty payload is a
 * protocol violation. This schema is FROZEN: SEC-RT-03 validates every emitted
 * frame against it. Client reaction: trigger the single-flight sync loop.
 */
export const zSyncPokeMessage = z.strictObject({
  type: z.literal('sync.poke'),
  payload: z.strictObject({}),
});
export type SyncPokeMessage = z.infer<typeof zSyncPokeMessage>;

/** Known v0 message registry — new types are additive (api/00 §4). */
export const zWsMessage = z.discriminatedUnion('type', [zSyncPokeMessage]);
export type WsMessage = z.infer<typeof zWsMessage>;
