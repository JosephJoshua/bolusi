// The RN realtime adapters — the CLIENT half of task 20's realtime channel, ACTIVATED on the target
// (task 105). Task 20 shipped + falsified the platform-free `RealtimeController` (@bolusi/core/realtime)
// with its socket / SSE-reader / trigger / clock / timer seams, and the server WS/SSE poke hub, under
// fakes; it explicitly deferred the RN socket/fetch adapters. Nothing in apps/mobile constructed the
// controller, so a shipping device got NO pokes and fell back to the 60 s periodic sync trigger only.
// This file binds the REAL transports + the sync-loop trigger, so a `sync.poke` now drives a low-latency
// pull. Same "typed and compiling ≠ running on the target" shape as task 102 (denial-audit timer).
//
// ── SEC-RT-01: BEARER AT CONNECT, NEVER A QUERY-STRING TOKEN ─────────────────────────────────────
// The device token authenticates BOTH transports via the `Authorization: Bearer <bdt_…>` REQUEST
// HEADER on the upgrade/stream GET — RN's `WebSocket` takes request headers in its 3rd `options` arg
// (RN 0.86 network.md, `options.headers`), and streaming `fetch` takes them in `headers`. The token is
// NEVER placed in the URL / query string (api/00 §3: "Tokens never appear in URLs, query strings, or
// logs — header only, on WS/SSE upgrade requests too"; SEC-RT-01). It is read PER CONNECT from
// SecureStore (never cached), so a revoked device stops authenticating at once (api/02-auth §7.3) —
// the same discipline `transport.ts` uses for the sync fetch legs.
//
// ── NODE-SAFE, LIKE systemTimer ─────────────────────────────────────────────────────────────────
// `WebSocket` and `fetch` are standard globals in BOTH RN and Node 22, so — unlike op-sqlite / NetInfo
// — they need no native-binding-site injection (index.ts); the defaults resolve the globals. They are
// injectable ONLY so the composed test can drive the REAL controller + REAL adapter seam with a fake
// socket and a fake streamed body, with ZERO sockets (T-6).
//
// ── ON-DEVICE TRANSPORT IS UNVERIFIABLE HERE (§2.11 honesty) ────────────────────────────────────
// The WS leg's real socket and the SSE leg's real streamed `Response.body` only carry bytes on an
// iOS/Android target (D12/D13); this Node lane proves the controller wiring, the auth mechanism, and
// the SSE frame reconstruction — not that the native stream delivers end-to-end. That is SAFE BY
// CONSTRUCTION: realtime is PURELY ADDITIVE (FR-1146). If a rung never carries a byte on device, the
// controller degrades WS→SSE→polling and the 60 s periodic keeps sync converging. Nothing here can make
// sync incorrect; a dead channel costs only latency.
import {
  RealtimeController,
  type ClockPort,
  type RealtimeTransportCallbacks,
  type RealtimeTransportFactory,
  type RuntimeTimerPort,
} from '@bolusi/core';

/** The subset of RN's `WebSocket` instance the adapter drives (a WHATWG-ish event surface). */
export interface RealtimeSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: (() => void) | null;
  close(code?: number, reason?: string): void;
}

/**
 * RN's `WebSocket` constructor: `(url, protocols?, options?)`, where `options.headers` sets request
 * headers on the UPGRADE (RN 0.86 network.md) — the SEC-RT-01 bearer-at-connect seam. The DOM `lib`
 * type omits the 3rd `options` arg, so the constructor shape is declared here and the global is cast in.
 */
export interface RealtimeSocketCtor {
  new (
    url: string,
    protocols: string | string[] | null | undefined,
    options: { headers: Record<string, string> },
  ): RealtimeSocketLike;
}

/** The transport-adapter inputs (no controller concerns): base URL + the per-connect token reader, plus
 *  the injectable `WebSocket` / `fetch` seams (default to the globals). */
export interface RealtimeTransportConfig {
  /** 08 §6.1's `EXPO_PUBLIC_API_URL`, no trailing slash (https on device). */
  readonly baseUrl: string;
  /** The `bdt_`-prefixed device token (api/02-auth §3/§8), read at CONNECT time — never cached here. */
  readonly loadDeviceToken: () => Promise<string | null>;
  /** Injected for tests; defaults to the RN/global `WebSocket`. */
  readonly webSocketImpl?: RealtimeSocketCtor;
  /** Injected for tests; defaults to the RN/global `fetch`. */
  readonly sseFetchImpl?: typeof fetch;
}

/** Everything `createRealtimeController` needs: the transports + the controller's own seams. */
export interface RealtimeClientConfig extends RealtimeTransportConfig {
  /** The sync-loop trigger — the controller's ONLY output (a poke / a (re)connect backfill). */
  readonly trigger: () => void;
  readonly clock: ClockPort;
  readonly timer: RuntimeTimerPort;
}

/** The controller lifecycle the sync client drives ALONGSIDE the loop. `RealtimeController` satisfies it. */
export interface RealtimeHandle {
  start(): void;
  stop(): void;
}

/** `https://host` → `wss://host/v1/realtime` (api/00 §1). `baseUrl` has no trailing slash (08 §6.1). */
function toWsUrl(baseUrl: string): string {
  const scheme = baseUrl.startsWith('http://') ? 'ws://' : 'wss://';
  const host = baseUrl.replace(/^https?:\/\//, '');
  return `${scheme}${host}/v1/realtime`;
}

function closeQuietly(socket: RealtimeSocketLike | null): void {
  if (socket === null) return;
  try {
    socket.close();
  } catch {
    // A transport already gone must not throw out of teardown.
  }
}

/**
 * The WebSocket factory (primary transport, api/00 §12.1). `open` returns a handle SYNCHRONOUSLY; the
 * per-connect token read happens async, and the socket is constructed after it resolves. A missing token
 * fails closed (SEC-RT-01) as a connect failure the controller counts and walks the ladder from.
 */
function createWsFactory(config: RealtimeTransportConfig): RealtimeTransportFactory {
  const url = toWsUrl(config.baseUrl);
  const Ctor = config.webSocketImpl ?? (globalThis.WebSocket as unknown as RealtimeSocketCtor);
  return {
    open(callbacks: RealtimeTransportCallbacks) {
      let socket: RealtimeSocketLike | null = null;
      let disposed = false;
      // RN fires `onerror` THEN `onclose` on a failed/dropped socket; the controller wants ONE terminal
      // per connection (ports.ts), so `terminate` collapses the pair to whichever arrives first.
      let terminated = false;
      const terminate = (deliver: () => void): void => {
        if (terminated) return;
        terminated = true;
        deliver();
      };
      void (async () => {
        const token = await config.loadDeviceToken().catch(() => null);
        if (disposed) return;
        if (token === null) {
          // SEC-RT-01 fail-closed: never open an unauthenticated socket. To the controller this is a
          // connect failure (never opened) — it counts it and walks WS→SSE→polling, as a 401 would.
          terminate(() => callbacks.onError());
          return;
        }
        try {
          socket = new Ctor(url, null, { headers: { Authorization: `Bearer ${token}` } });
        } catch (error) {
          terminate(() => callbacks.onError(error));
          return;
        }
        if (disposed) {
          closeQuietly(socket);
          return;
        }
        socket.onopen = (): void => {
          if (!disposed) callbacks.onOpen();
        };
        socket.onmessage = (event): void => {
          if (!disposed) callbacks.onMessage(event.data);
        };
        socket.onerror = (event): void => terminate(() => callbacks.onError(event));
        socket.onclose = (): void => terminate(() => callbacks.onClose());
      })();
      return {
        close(): void {
          disposed = true;
          terminate(() => undefined);
          closeQuietly(socket);
        },
      };
    },
  };
}

/** Find the earliest SSE event boundary (`\n\n` or `\r\n\r\n`) in `buffer`, or `null`. */
function nextEventBoundary(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return null;
  if (crlf === -1 || (lf !== -1 && lf < crlf)) return { index: lf, length: 2 };
  return { index: crlf, length: 4 };
}

/**
 * Turn one raw SSE event block into the WS-frame shape the controller consumes and forward it.
 *
 * The controller's `#handleFrame` JSON-parses a STRING and validates `zWsFrame` (`{ type, payload }`).
 * SSE carries a poke as `event: sync.poke` + `data: {}` (the PAYLOAD only), so we rebuild
 * `{ type: <event>, payload: <data verbatim> }` as a JSON string. If `data` is not valid JSON the
 * controller counts it `droppedMalformed` — identical handling to a bad WS frame. A block with no `data`
 * field (a lone `: hb` heartbeat) is nothing to deliver.
 */
function forwardSseEvent(rawEvent: string, callbacks: RealtimeTransportCallbacks): void {
  let eventName = 'message';
  const dataLines: string[] = [];
  for (const line of rawEvent.split('\n')) {
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (clean === '' || clean.startsWith(':')) continue; // heartbeat comment / blank line
    const colon = clean.indexOf(':');
    const field = colon === -1 ? clean : clean.slice(0, colon);
    let value = colon === -1 ? '' : clean.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
    // `id` / `retry` fields are ignored (the controller owns backfill; SSE `id` is not a sync cursor).
  }
  if (dataLines.length === 0) return;
  const data = dataLines.join('\n');
  callbacks.onMessage(`{"type":${JSON.stringify(eventName)},"payload":${data}}`);
}

/**
 * The SSE reader factory (fallback transport, api/00 §12.2). RN has no native `EventSource`, so the
 * stream is consumed with streaming `fetch` (`Response.body.getReader()`) and the same bearer header. A
 * non-200 (a 401 — SEC-RT-01) or a runtime with no streamable body is a connect failure → the controller
 * degrades to polling; correctness never depends on this rung (FR-1146).
 */
function createSseFactory(config: RealtimeTransportConfig): RealtimeTransportFactory {
  const url = `${config.baseUrl}/v1/realtime/sse`;
  const doFetch = config.sseFetchImpl ?? globalThis.fetch;
  return {
    open(callbacks: RealtimeTransportCallbacks) {
      const abort = new AbortController();
      let terminated = false;
      const terminate = (deliver: () => void): void => {
        if (terminated) return;
        terminated = true;
        deliver();
      };
      void (async () => {
        const token = await config.loadDeviceToken().catch(() => null);
        if (terminated) return;
        if (token === null) {
          terminate(() => callbacks.onError());
          return;
        }
        let response: Response;
        try {
          response = await doFetch(url, {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
            signal: abort.signal,
          });
        } catch (error) {
          terminate(() => callbacks.onError(error));
          return;
        }
        if (terminated) return;
        const body = response.body;
        if (!response.ok || body === null) {
          terminate(() => callbacks.onError());
          return;
        }
        callbacks.onOpen();
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            let boundary = nextEventBoundary(buffer);
            while (boundary !== null) {
              const rawEvent = buffer.slice(0, boundary.index);
              buffer = buffer.slice(boundary.index + boundary.length);
              forwardSseEvent(rawEvent, callbacks);
              boundary = nextEventBoundary(buffer);
            }
          }
          terminate(() => callbacks.onClose());
        } catch (error) {
          terminate(() => callbacks.onError(error));
        }
      })();
      return {
        close(): void {
          terminate(() => undefined);
          abort.abort();
        },
      };
    },
  };
}

/** Build the two realtime transports (WS primary + SSE fallback) over the config's URL + token reader. */
export function createRnRealtimeTransports(config: RealtimeTransportConfig): {
  ws: RealtimeTransportFactory;
  sse: RealtimeTransportFactory;
} {
  return { ws: createWsFactory(config), sse: createSseFactory(config) };
}

/**
 * Construct the `RealtimeController` (from @bolusi/core) over the RN transports — the whole client
 * realtime, ready to `start()`/`stop()`. The controller owns the §12.3 ladder; this only binds the
 * platform transports + the trigger/clock/timer seams.
 */
export function createRealtimeController(config: RealtimeClientConfig): RealtimeController {
  const transports = createRnRealtimeTransports(config);
  return new RealtimeController({
    ws: transports.ws,
    sse: transports.sse,
    trigger: config.trigger,
    clock: config.clock,
    timer: config.timer,
  });
}
