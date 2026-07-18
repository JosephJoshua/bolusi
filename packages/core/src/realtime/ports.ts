// The realtime client controller's injected seams (08-stack-and-repo §3.2/§3.3; testing-guide T-6).
//
// @bolusi/core is PLATFORM-FREE (08 §3.3 rule 3): NO `ws`, NO `fetch`, NO `EventSource`, NO
// `setTimeout`. The realtime controller is *made* of sockets and time, so every one of those
// arrives here as an interface. The RN adapters that bind a real WebSocket / streaming `fetch` to
// these ports are task 24; the harness binds fakes. That is what lets the whole §12.3 fallback
// ladder run under a FakeClock with fake transports and zero sockets.
//
// A WS and an SSE stream have the SAME lifecycle from the controller's view — open, deliver text
// frames, error, close — so ONE factory shape serves both legs (two instances: `ws`, `sse`). The
// controller never sends (v0 realtime is server→client only, api/00 §12.1), so there is no `send`.
import type { ClockPort, RuntimeTimerPort } from '../runtime/ports.js';

/** A live transport the controller can tear down. Returned by `RealtimeTransportFactory.open`. */
export interface RealtimeTransportHandle {
  /** Close the transport. Idempotent; after this the controller ignores its late callbacks. */
  close(): void;
}

/**
 * The lifecycle callbacks the controller hands to a transport at `open`. Exactly one terminal
 * callback fires per connection: `onClose` (graceful/dropped) or `onError` (failed to establish or
 * mid-stream fault) — the controller treats both as "this connection is gone" and reconnects.
 */
export interface RealtimeTransportCallbacks {
  /** The socket/stream is established and ready to receive frames. */
  onOpen(): void;
  /** A server→client frame arrived. WS text / SSE `data`. Non-string (binary) is passed through so
   *  the controller can count-and-ignore it (api/00 §12.1). */
  onMessage(data: unknown): void;
  /** The transport failed to open, or faulted mid-stream. */
  onError(error?: unknown): void;
  /** The transport closed. */
  onClose(): void;
}

/** Opens one transport (a WS or an SSE stream), wiring the controller's callbacks to it. */
export interface RealtimeTransportFactory {
  open(callbacks: RealtimeTransportCallbacks): RealtimeTransportHandle;
}

export interface RealtimeControllerDeps {
  /** Primary transport: the WebSocket (api/00 §12.1). */
  readonly ws: RealtimeTransportFactory;
  /** Fallback transport: the SSE stream (api/00 §12.2). */
  readonly sse: RealtimeTransportFactory;
  /**
   * Fire the sync loop — the ONLY job of a poke and of a (re)connect backfill (api/01-sync §5/§6).
   *
   * FIRE-AND-FORGET, AND NEVER GATING. This is wired to `SyncLoop.requestSync(...)` by the app
   * (task 24); the controller calls it on a poke and on connect, NEVER on a timer. A realtime
   * trigger is therefore additive to the api/01-sync §5 trigger set, not a replacement — the 60 s
   * periodic keeps polling regardless of transport state, and the loop's own single-flight
   * coalescing (api/01-sync §6) collapses rapid pokes. Correctness never depends on the channel
   * (FR-1146): there is no path from controller state into loop gating, by construction.
   */
  readonly trigger: () => void;
  readonly clock: ClockPort;
  readonly timer: RuntimeTimerPort;
}
