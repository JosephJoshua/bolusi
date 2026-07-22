// The realtime connection hub (api/00 §12.1; api/01-sync §4.1/§4.3). WS + SSE transports SUBSCRIBE
// here by `register`ing a `RealtimeConnection`; the sync push handler's accepted-op scopes arrive as
// `pokeAccepted(scope)` (wired to `poke-hub.ts` in routes/realtime.ts — task 16 publishes, task 20
// fans out). The hub owns the four §12.1 invariants that are NOT the transport's business:
//
//   1. SCOPE ROUTING (the load-bearing tenant filter). A connection is poked iff the accepted op's
//      pull scope contains it (api/01-sync §4.3): same tenant AND (op store === conn store OR op is
//      tenant-scoped). A device therefore never learns *that* another tenant — or another store —
//      had activity (security-guide §9.1 "must not even learn that"). SEC-RT-04 is this line.
//   2. COALESCING: at most one `sync.poke` per connection per second (§12.1). A poke carries no data
//      (it only says "pull") so collapsing a burst costs nothing but a little latency (api/01 §8).
//   3. KEEPALIVE: WS sends a protocol ping every 30 s and is closed after 2 missed pongs; SSE emits
//      a `: hb` comment every 25 s and is fire-and-forget (no pong to miss). Per-connection cadence,
//      injectable for tests (testing-guide T-6 — a test that sleeps is a bug).
//   4. LIFECYCLE: max one live connection per device token (a second upgrade closes the first), and
//      `closeForDevice` for revocation (SEC-RT-02). `dispose` cleans up on any transport close, so
//      the registry returns to baseline after every disconnect (no leaks).
//
// Correctness NEVER depends on any of this (FR-1146): a dropped poke, a coalesced poke, a closed
// socket — all cost only pull latency. The authoritative data path is the signed op-log pull.
import type { PokeScope } from './poke-hub.js';

/** The frozen `sync.poke` frame (api/00 §12.1). Payload is exactly `{}` — SEC-RT-03 asserts every
 *  emitted WS text frame equals this, so no business value can ever ride the realtime channel. */
export const SYNC_POKE_FRAME = JSON.stringify({ type: 'sync.poke', payload: {} });

/** WS protocol ping cadence (api/00 §12.1). */
export const WS_PING_INTERVAL_MS = 30_000;
/** SSE `: hb` comment cadence (api/00 §12.2). */
export const SSE_HEARTBEAT_INTERVAL_MS = 25_000;
/** ≤ 1 poke per connection per second (api/00 §12.1). */
export const DEFAULT_COALESCE_WINDOW_MS = 1_000;
/** Close a WS after this many unanswered pings (api/00 §12.1 "2 missed pongs"). */
export const DEFAULT_MAX_MISSED_PONGS = 2;
/** Flood ceiling: v0 clients send NO frames, so any inbound traffic is abuse; past this we close
 *  the socket (SEC-RT-05 "message flood → connection closed per limits"). */
export const DEFAULT_MAX_CLIENT_MESSAGES = 100;

/** Cancels a scheduled callback; calling after it fired (or a second time) is a no-op. */
export interface HubTimerHandle {
  cancel(): void;
}

/**
 * One-shot delay seam (08 §3.2; testing-guide T-6). Production wraps an `unref`'d `setTimeout`
 * (`nodeHubScheduler`); tests inject a controllable fake so coalescing/keepalive are asserted
 * without sleeping. Recurring cadences self-reschedule on top of this one primitive.
 */
export interface HubScheduler {
  setTimer(delayMs: number, fn: () => void): HubTimerHandle;
}

/** Node-timer `HubScheduler`. `unref` so a live keepalive timer never keeps the process alive. */
export const nodeHubScheduler: HubScheduler = {
  setTimer(delayMs, fn) {
    const handle = setTimeout(fn, delayMs);
    handle.unref?.();
    return { cancel: () => clearTimeout(handle) };
  },
};

/**
 * A live realtime transport the hub fans pokes out to. The WS and SSE routes each build one over
 * their underlying primitive (a `ws` socket / an SSE stream). The hub speaks ONLY this interface,
 * so it is transport-agnostic and unit-testable with fakes.
 */
export interface RealtimeConnection {
  readonly deviceId: string;
  readonly tenantId: string;
  /** `null` for a system device — it hears only tenant-scoped pokes (api/01-sync §4.3). */
  readonly storeId: string | null;
  /** Emit exactly one `sync.poke` to the client (a WS text frame / an SSE `event: sync.poke`). */
  emitPoke(): void;
  /** Liveness probe fired each keepalive tick: a WS protocol ping, or an SSE `: hb` comment. */
  probe(): void;
  /** Milliseconds between probes (WS 30 000, SSE 25 000). */
  readonly heartbeatIntervalMs: number;
  /** WS answers probes with pongs (drives the missed-pong close); SSE has no pong. */
  readonly tracksLiveness: boolean;
  /** Terminate the underlying transport. Idempotent from the hub's side. */
  close(): void;
}

/** The handle returned by `register`. The transport route wires its raw events into these. */
export interface HubRegistration {
  /** A WS pong arrived — resets the missed-pong counter. No-op for SSE. */
  notifyPong(): void;
  /** A client→server frame arrived. v0 drops + counts it; a flood closes the socket (SEC-RT-05). */
  notifyClientMessage(): void;
  /** The transport closed (client disconnect, error, or server close) — remove it from the registry. */
  dispose(): void;
}

export interface RealtimeHubOptions {
  readonly now: () => number;
  readonly scheduler: HubScheduler;
  readonly coalesceWindowMs?: number;
  readonly maxMissedPongs?: number;
  readonly maxClientMessages?: number;
}

interface Entry {
  readonly conn: RealtimeConnection;
  /** Wall-clock of the last emitted poke; `-Infinity` until the first. */
  lastPokeAt: number;
  /** A poke landed inside the coalescing window and is owed a single trailing emit. */
  pendingTrailing: boolean;
  coalesceTimer: HubTimerHandle | null;
  /** Consecutive unanswered WS pings (reset by `notifyPong`). */
  missedPongs: number;
  clientMessages: number;
  keepaliveTimer: HubTimerHandle | null;
  disposed: boolean;
}

/**
 * A device (`conn`) is in an accepted op's fan-out set iff that op is in the device's pull scope
 * (api/01-sync §4.3): `op.tenantId === device.tenantId AND (op.storeId === device.storeId OR
 * op.storeId IS NULL)`. This is the SAME predicate the pull query uses — the poke can never reach
 * a device the pull would not have served, so the realtime channel leaks nothing the data path
 * would not. THIS LINE IS SEC-RT-04: weaken the tenant clause and a tenant-A device hears tenant B.
 */
export function scopeMatchesConnection(scope: PokeScope, conn: RealtimeConnection): boolean {
  return (
    scope.tenantId === conn.tenantId && (scope.storeId === null || scope.storeId === conn.storeId)
  );
}

export class RealtimeHub {
  readonly #now: () => number;
  readonly #scheduler: HubScheduler;
  readonly #coalesceWindowMs: number;
  readonly #maxMissedPongs: number;
  readonly #maxClientMessages: number;
  readonly #entries = new Set<Entry>();
  /** Enforces one live connection per device token (api/00 §12.1). */
  readonly #byDevice = new Map<string, Entry>();

  constructor(options: RealtimeHubOptions) {
    this.#now = options.now;
    this.#scheduler = options.scheduler;
    this.#coalesceWindowMs = options.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
    this.#maxMissedPongs = options.maxMissedPongs ?? DEFAULT_MAX_MISSED_PONGS;
    this.#maxClientMessages = options.maxClientMessages ?? DEFAULT_MAX_CLIENT_MESSAGES;
  }

  /** Live connection count — asserted to return to baseline after disconnects (no leaks). */
  get connectionCount(): number {
    return this.#entries.size;
  }

  /**
   * `LiveConnectionRegistry` (push/fanout.ts): does this device hold a live WS/SSE connection right
   * now? A `sync` push is sent ONLY to devices for which this is false — the realtime poke already
   * covers connected ones (api/04-push §6). `#byDevice` is the single-connection-per-device map, so
   * this is exact: a disposed/torn-down entry is already removed from it.
   */
  isConnected(deviceId: string): boolean {
    return this.#byDevice.has(deviceId);
  }

  register(conn: RealtimeConnection): HubRegistration {
    // Single connection per device: a second upgrade for the same token closes the first (§12.1).
    const existing = this.#byDevice.get(conn.deviceId);
    if (existing !== undefined) {
      this.#teardown(existing, true);
    }
    const entry: Entry = {
      conn,
      lastPokeAt: Number.NEGATIVE_INFINITY,
      pendingTrailing: false,
      coalesceTimer: null,
      missedPongs: 0,
      clientMessages: 0,
      keepaliveTimer: null,
      disposed: false,
    };
    this.#entries.add(entry);
    this.#byDevice.set(conn.deviceId, entry);
    this.#scheduleKeepalive(entry);
    return {
      notifyPong: () => {
        entry.missedPongs = 0;
      },
      notifyClientMessage: () => this.#onClientMessage(entry),
      dispose: () => this.#teardown(entry, false),
    };
  }

  /** Fan a scoped poke out to every matching connection (task 16 → `poke-hub` → here). */
  pokeAccepted(scope: PokeScope): void {
    for (const entry of this.#entries) {
      if (entry.disposed) continue;
      if (scopeMatchesConnection(scope, entry.conn)) {
        this.#coalesceEmit(entry);
      }
    }
  }

  /** Revocation (SEC-RT-02): close the device's live socket now. Reconnect is refused at auth. */
  closeForDevice(deviceId: string): void {
    const entry = this.#byDevice.get(deviceId);
    if (entry !== undefined) {
      this.#teardown(entry, true);
    }
  }

  #coalesceEmit(entry: Entry): void {
    const nowMs = this.#now();
    const elapsed = nowMs - entry.lastPokeAt;
    if (elapsed >= this.#coalesceWindowMs) {
      entry.conn.emitPoke();
      entry.lastPokeAt = nowMs;
      entry.pendingTrailing = false;
      return;
    }
    // Inside the window: owe a single trailing emit at the window's edge — a burst of N pokes
    // yields exactly one leading frame now and (once time advances past the window) one trailing.
    entry.pendingTrailing = true;
    if (entry.coalesceTimer === null) {
      entry.coalesceTimer = this.#scheduler.setTimer(this.#coalesceWindowMs - elapsed, () => {
        entry.coalesceTimer = null;
        if (entry.disposed || !entry.pendingTrailing) return;
        entry.conn.emitPoke();
        entry.lastPokeAt = this.#now();
        entry.pendingTrailing = false;
      });
    }
  }

  #scheduleKeepalive(entry: Entry): void {
    entry.keepaliveTimer = this.#scheduler.setTimer(entry.conn.heartbeatIntervalMs, () => {
      entry.keepaliveTimer = null;
      if (entry.disposed) return;
      if (entry.conn.tracksLiveness) {
        // Two pings have gone unanswered — the socket is dead. Close before sending a third.
        if (entry.missedPongs >= this.#maxMissedPongs) {
          this.#teardown(entry, true);
          return;
        }
        entry.missedPongs += 1;
      }
      entry.conn.probe();
      this.#scheduleKeepalive(entry);
    });
  }

  #onClientMessage(entry: Entry): void {
    // v0 ignores ALL client frames (api/00 §12.1). We only COUNT them, so a flood is visible and
    // closable — the channel must not become a client→server data plane (security-guide §9.1).
    entry.clientMessages += 1;
    if (entry.clientMessages > this.#maxClientMessages) {
      this.#teardown(entry, true);
    }
  }

  #teardown(entry: Entry, closeTransport: boolean): void {
    if (entry.disposed) return;
    entry.disposed = true;
    entry.coalesceTimer?.cancel();
    entry.keepaliveTimer?.cancel();
    entry.coalesceTimer = null;
    entry.keepaliveTimer = null;
    this.#entries.delete(entry);
    // Only unmap if THIS entry still owns the device slot — a re-register may have replaced it.
    if (this.#byDevice.get(entry.conn.deviceId) === entry) {
      this.#byDevice.delete(entry.conn.deviceId);
    }
    if (closeTransport) {
      try {
        entry.conn.close();
      } catch {
        // Best-effort: a socket already gone must not throw out of the hub (api/01-sync §8).
      }
    }
  }
}
