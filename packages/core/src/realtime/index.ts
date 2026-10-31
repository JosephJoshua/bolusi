// The realtime client controller (api/00 §12.3): poke → sync-loop trigger, backfill on (re)connect,
// and the WS→SSE→polling fallback ladder — all effects behind injected ports (08 §3.3). Explicit
// named exports (matching `sync/`), not `export *`: the transport ports are the public seam the RN
// adapters (task 24) bind; nothing else is API.
export {
  RealtimeController,
  DEGRADED_WS_RETRY_MS,
  SSE_CONNECT_FAILURES_TO_POLLING,
  SSE_IDLE_LIMIT_MS,
  WS_CONNECT_FAILURES_TO_SSE,
  type RealtimeControllerState,
  type RealtimeControllerStats,
  type RealtimeRung,
} from './controller.js';
export {
  type RealtimeControllerDeps,
  type RealtimeTransportCallbacks,
  type RealtimeTransportFactory,
  type RealtimeTransportHandle,
} from './ports.js';
