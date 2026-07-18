// The realtime client controller (api/00 §12.3). It owns the transport lifecycle and the fallback
// ladder; its ONLY output is calling `trigger()` — the sync loop's single entry point — on a poke
// and on every (re)connect. It never pulls, never parses op data, never gates sync.
//
// FR-1146 BY CONSTRUCTION. There is exactly one edge from this controller into the rest of the
// system: `deps.trigger()`, called on (a) a `sync.poke` frame and (b) a transport open (backfill).
// It is called on NO timer. So realtime is purely additive to the api/01-sync §5 trigger set — the
// 60 s periodic keeps polling whatever this controller is doing, and if this controller is wedged
// in `failed`/`polling` state, every §5 trigger still fires and sync still converges. Nothing here
// can block or delay a pull; the loop's own single-flight (api/01-sync §6) coalesces the triggers.
//
// THE LADDER (api/00 §12.3), reusing the sync backoff schedule (5 s→15 s→60 s→5 min cap):
//   1. WS is primary. A drop reconnects with backoff (a successful open resets the streak).
//   2. 3 consecutive WS *connect* failures → switch the primary to SSE (same backoff schedule).
//   3. 3 consecutive SSE connect failures → polling-only: NO active transport, and — the point —
//      NO realtime-owned pull cadence. The existing 60 s periodic sync trigger IS the polling.
//   4. While degraded (SSE or polling), a 5-minute WS *recovery probe* runs IN PARALLEL (the lower
//      rung keeps working). On WS success it is promoted to primary, the lower rung is torn down,
//      and every counter resets. The probe is a connection attempt only — it never triggers a pull
//      unless it actually connects (which is a legitimate backfill), so it is not a pull cadence.
import { zWsFrame } from '@bolusi/schemas';

import { syncBackoffDelayMs } from '../sync/backoff.js';
import type { RealtimeControllerDeps, RealtimeTransportHandle } from './ports.js';

/** 3 consecutive WS connect failures → SSE (api/00 §12.3.2). */
export const WS_CONNECT_FAILURES_TO_SSE = 3;
/** 3 consecutive SSE connect failures → polling-only (api/00 §12.3.3). Symmetric with the WS rung;
 *  the spec fixes the WS count at 3 and leaves the SSE count implicit — we take the same threshold. */
export const SSE_CONNECT_FAILURES_TO_POLLING = 3;
/** Retry WS every 5 minutes while degraded (api/00 §12.3.4). Equals the backoff cap by design. */
export const DEGRADED_WS_RETRY_MS = 300_000;

/** The transport rung currently maintained as primary. `polling` means no active transport. */
export type RealtimeRung = 'ws' | 'sse' | 'polling';

export interface RealtimeControllerState {
  readonly rung: RealtimeRung;
  readonly connected: boolean;
}

/** Observable counters — for tests and diagnostics; not a contract with the UI. */
export interface RealtimeControllerStats {
  /** `sync.poke` frames that fired a trigger. */
  readonly pokes: number;
  /** (re)connect backfill triggers fired. */
  readonly backfills: number;
  readonly droppedBinary: number;
  readonly droppedMalformed: number;
  readonly droppedUnknown: number;
  /** Cumulative WS connect failures (never-opened attempts). */
  readonly wsConnectFailures: number;
  /** Cumulative SSE connect failures. */
  readonly sseConnectFailures: number;
}

/** One in-flight connection attempt. `token` is object identity — a stale callback whose token is
 *  no longer the current one for its role is ignored (guards against late events after teardown). */
interface Conn {
  role: 'primary' | 'recovery';
  readonly token: object;
  readonly rung: 'ws' | 'sse';
  opened: boolean;
}

export class RealtimeController {
  readonly #deps: RealtimeControllerDeps;

  #started = false;
  #stopped = false;

  #rung: RealtimeRung = 'ws';
  #connected = false;

  #primaryConn: Conn | null = null;
  #primaryHandle: RealtimeTransportHandle | null = null;
  #recoveryConn: Conn | null = null;
  #recoveryHandle: RealtimeTransportHandle | null = null;

  /** Index into the backoff schedule for the NEXT reconnect on the current rung. */
  #backoffAttempt = 0;
  #wsConnectFailures = 0;
  #sseConnectFailures = 0;

  #reconnectTimer: (() => void) | null = null;
  #wsRetryTimer: (() => void) | null = null;

  #stats: RealtimeControllerStats = {
    pokes: 0,
    backfills: 0,
    droppedBinary: 0,
    droppedMalformed: 0,
    droppedUnknown: 0,
    wsConnectFailures: 0,
    sseConnectFailures: 0,
  };

  constructor(deps: RealtimeControllerDeps) {
    // `deps.clock` is part of the port shape (matching the sync loop, so one adapter binds both);
    // the ladder is purely timer-driven, so the controller reads `timer`, not `clock`.
    this.#deps = deps;
  }

  get state(): RealtimeControllerState {
    return { rung: this.#rung, connected: this.#connected };
  }

  getStats(): RealtimeControllerStats {
    return this.#stats;
  }

  /** Begin connecting (WS). Idempotent; a stopped controller does not restart. */
  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    this.#rung = 'ws';
    this.#connectPrimary();
  }

  /** Tear down all transports + timers. Late transport callbacks are ignored afterwards. */
  stop(): void {
    this.#stopped = true;
    this.#clearReconnectTimer();
    this.#clearWsRetryTimer();
    this.#closeHandle(this.#primaryHandle);
    this.#closeHandle(this.#recoveryHandle);
    this.#primaryHandle = null;
    this.#recoveryHandle = null;
    this.#primaryConn = null;
    this.#recoveryConn = null;
    this.#connected = false;
  }

  // ── connection management ────────────────────────────────────────────────────────────────────

  #connectPrimary(): void {
    this.#clearReconnectTimer();
    if (this.#rung === 'polling') {
      // No active transport — the 60 s periodic sync trigger IS the polling (api/00 §12.3.3).
      this.#ensureDegradedRetry();
      return;
    }
    this.#openConn('primary', this.#rung);
  }

  #openConn(role: 'primary' | 'recovery', rung: 'ws' | 'sse'): void {
    const conn: Conn = { role, token: {}, rung, opened: false };
    if (role === 'primary') this.#primaryConn = conn;
    else this.#recoveryConn = conn;
    const factory = rung === 'ws' ? this.#deps.ws : this.#deps.sse;
    const handle = factory.open({
      onOpen: () => this.#onOpen(conn),
      onMessage: (data) => this.#onMessage(conn, data),
      onError: () => this.#onClosed(conn),
      onClose: () => this.#onClosed(conn),
    });
    if (role === 'primary') this.#primaryHandle = handle;
    else this.#recoveryHandle = handle;
  }

  #isCurrent(conn: Conn): boolean {
    return conn.role === 'primary' ? conn === this.#primaryConn : conn === this.#recoveryConn;
  }

  #onOpen(conn: Conn): void {
    if (this.#stopped || !this.#isCurrent(conn)) return;
    conn.opened = true;
    if (conn.role === 'recovery') {
      this.#promoteRecovery(conn);
      return;
    }
    this.#connected = true;
    this.#backoffAttempt = 0;
    if (this.#rung === 'ws') this.#wsConnectFailures = 0;
    else this.#sseConnectFailures = 0;
    this.#fireBackfill();
  }

  #onMessage(conn: Conn, data: unknown): void {
    if (this.#stopped || !this.#isCurrent(conn)) return;
    this.#handleFrame(data);
  }

  #onClosed(conn: Conn): void {
    if (this.#stopped || !this.#isCurrent(conn)) return;

    if (conn.role === 'recovery') {
      // The parallel WS recovery probe failed/closed before promotion — drop it, keep the lower
      // rung running, and reschedule the 5-minute retry.
      this.#recoveryConn = null;
      this.#recoveryHandle = null;
      this.#ensureDegradedRetry();
      return;
    }

    this.#primaryConn = null;
    this.#primaryHandle = null;
    this.#connected = false;

    if (conn.opened) {
      // A DROP (it had connected). Reconnect on the same rung; the connect-failure streak stays 0
      // (a successful open reset it), so a drop alone never escalates.
      this.#scheduleReconnect();
      return;
    }

    // A CONNECT FAILURE (never opened) — count it and escalate at the threshold.
    if (this.#rung === 'ws') {
      this.#wsConnectFailures += 1;
      this.#bumpStat('wsConnectFailures');
      if (this.#wsConnectFailures >= WS_CONNECT_FAILURES_TO_SSE) {
        this.#escalate('sse');
        return;
      }
    } else {
      this.#sseConnectFailures += 1;
      this.#bumpStat('sseConnectFailures');
      if (this.#sseConnectFailures >= SSE_CONNECT_FAILURES_TO_POLLING) {
        this.#escalate('polling');
        return;
      }
    }
    this.#scheduleReconnect();
  }

  #escalate(to: 'sse' | 'polling'): void {
    this.#clearReconnectTimer();
    this.#rung = to;
    this.#backoffAttempt = 0;
    if (to === 'sse') this.#sseConnectFailures = 0;
    this.#ensureDegradedRetry();
    this.#connectPrimary();
  }

  #promoteRecovery(conn: Conn): void {
    // WS is back while degraded — swap the recovery socket in as the primary and tear down the
    // lower rung. All counters reset (api/00 §12.3.4).
    this.#clearReconnectTimer();
    this.#closeHandle(this.#primaryHandle);
    conn.role = 'primary';
    this.#primaryConn = conn;
    this.#primaryHandle = this.#recoveryHandle;
    this.#recoveryConn = null;
    this.#recoveryHandle = null;
    this.#clearWsRetryTimer();
    this.#rung = 'ws';
    this.#backoffAttempt = 0;
    this.#wsConnectFailures = 0;
    this.#sseConnectFailures = 0;
    this.#connected = true;
    this.#fireBackfill();
  }

  #scheduleReconnect(): void {
    const delay = syncBackoffDelayMs(this.#backoffAttempt + 1);
    this.#backoffAttempt += 1;
    this.#reconnectTimer = this.#deps.timer.schedule(delay, () => {
      this.#reconnectTimer = null;
      if (this.#stopped) return;
      this.#connectPrimary();
    });
  }

  #ensureDegradedRetry(): void {
    // Only while degraded (not on WS). NOT a pull cadence — it opens a connection, and a pull only
    // follows if that connection actually establishes (a backfill), never on the timer alone.
    if (this.#stopped || this.#rung === 'ws' || this.#wsRetryTimer !== null) return;
    this.#wsRetryTimer = this.#deps.timer.schedule(DEGRADED_WS_RETRY_MS, () => {
      this.#wsRetryTimer = null;
      if (this.#stopped) return;
      this.#attemptWsRecovery();
      this.#ensureDegradedRetry();
    });
  }

  #attemptWsRecovery(): void {
    if (this.#stopped || this.#rung === 'ws' || this.#recoveryConn !== null) return;
    this.#openConn('recovery', 'ws');
  }

  // ── frame handling ──────────────────────────────────────────────────────────────────────────

  #handleFrame(data: unknown): void {
    if (typeof data !== 'string') {
      // An unexpected binary frame — ignored, counted, no throw (api/00 §12.1).
      this.#bumpStat('droppedBinary');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      this.#bumpStat('droppedMalformed');
      return;
    }
    const frame = zWsFrame.safeParse(parsed);
    if (!frame.success) {
      this.#bumpStat('droppedMalformed');
      return;
    }
    if (frame.data.type === 'sync.poke') {
      this.#bumpStat('pokes');
      this.#safeTrigger();
      return;
    }
    // Unknown type — clients ignore it (api/00 §4/§12.1), still counted.
    this.#bumpStat('droppedUnknown');
  }

  #fireBackfill(): void {
    this.#bumpStat('backfills');
    this.#safeTrigger();
  }

  #safeTrigger(): void {
    try {
      this.#deps.trigger();
    } catch {
      // The trigger is fire-and-forget (api/01-sync §6). A wired loop never throws here, but a
      // realtime callback must not crash the transport if it somehow did.
    }
  }

  // ── helpers ─────────────────────────────────────────────────────────────────────────────────

  #bumpStat(key: keyof RealtimeControllerStats): void {
    this.#stats = { ...this.#stats, [key]: this.#stats[key] + 1 };
  }

  #clearReconnectTimer(): void {
    this.#reconnectTimer?.();
    this.#reconnectTimer = null;
  }

  #clearWsRetryTimer(): void {
    this.#wsRetryTimer?.();
    this.#wsRetryTimer = null;
  }

  #closeHandle(handle: RealtimeTransportHandle | null): void {
    try {
      handle?.close();
    } catch {
      // A transport already gone must not throw out of teardown.
    }
  }
}
