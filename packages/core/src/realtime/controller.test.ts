// Realtime client controller tests (api/00 §12.3). Fake transport factories + a fake timer drive
// the whole fallback ladder with zero sockets and no sleeping (testing-guide T-1..T-3, T-6). The
// load-bearing property is FR-1146: the controller's ONLY output is `trigger()`, called on a poke
// and on connect, NEVER on a timer — so realtime can never gate or delay sync.
import { describe, expect, test } from 'vitest';

import { SYNC_BACKOFF_SCHEDULE_MS } from '../sync/backoff.js';
import { DEGRADED_WS_RETRY_MS, RealtimeController } from './controller.js';
import type {
  RealtimeControllerDeps,
  RealtimeTransportCallbacks,
  RealtimeTransportFactory,
  RealtimeTransportHandle,
} from './ports.js';

const POKE_FRAME = JSON.stringify({ type: 'sync.poke', payload: {} });

interface FakeConn {
  cb: RealtimeTransportCallbacks;
  closed: boolean;
}

class FakeFactory implements RealtimeTransportFactory {
  readonly opens: FakeConn[] = [];
  open(cb: RealtimeTransportCallbacks): RealtimeTransportHandle {
    const conn: FakeConn = { cb, closed: false };
    this.opens.push(conn);
    return {
      close: () => {
        conn.closed = true;
      },
    };
  }
  get count(): number {
    return this.opens.length;
  }
  get last(): FakeConn {
    const conn = this.opens.at(-1);
    if (conn === undefined) throw new Error('no connection opened');
    return conn;
  }
}

class FakeTimer {
  ms = 0;
  readonly scheduled: number[] = [];
  #timers: { at: number; fn: () => void; live: boolean }[] = [];
  schedule = (delayMs: number, fn: () => void): (() => void) => {
    this.scheduled.push(delayMs);
    const timer = { at: this.ms + delayMs, fn, live: true };
    this.#timers.push(timer);
    return () => {
      timer.live = false;
    };
  };
  advance(byMs: number): void {
    const target = this.ms + byMs;
    for (let guard = 0; guard < 100_000; guard += 1) {
      const due = this.#timers
        .filter((t) => t.live && t.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.ms = due.at;
      due.live = false;
      this.#timers = this.#timers.filter((t) => t !== due);
      due.fn();
    }
    this.ms = target;
  }
}

/** A synchronous single-flight stub mirroring `SyncLoop.requestSync` (api/01-sync §6): a trigger
 *  while a cycle is in flight sets the rerun flag rather than starting a parallel cycle. */
class SingleFlightLoop {
  cycles = 0;
  reruns = 0;
  #busy = false;
  requestSync(): void {
    if (this.#busy) {
      this.reruns += 1;
      return;
    }
    this.#busy = true;
    this.cycles += 1;
  }
  complete(): void {
    this.#busy = false;
  }
}

function makeDeps(over: Partial<RealtimeControllerDeps> = {}): {
  deps: RealtimeControllerDeps;
  ws: FakeFactory;
  sse: FakeFactory;
  timer: FakeTimer;
  triggers: number;
  triggerCount: () => number;
} {
  const ws = new FakeFactory();
  const sse = new FakeFactory();
  const timer = new FakeTimer();
  let triggers = 0;
  const deps: RealtimeControllerDeps = {
    ws,
    sse,
    trigger: () => {
      triggers += 1;
    },
    clock: { now: () => timer.ms },
    timer: { schedule: timer.schedule },
    ...over,
  };
  return { deps, ws, sse, timer, triggers, triggerCount: () => triggers };
}

describe('RealtimeController — poke handling', () => {
  test('a sync.poke frame invokes the trigger; connect fires exactly one backfill', () => {
    const { deps, ws, triggerCount } = makeDeps();
    const controller = new RealtimeController(deps);
    controller.start();
    ws.last.cb.onOpen();
    expect(controller.getStats().backfills).toBe(1);
    expect(triggerCount()).toBe(1); // backfill

    ws.last.cb.onMessage(POKE_FRAME);
    expect(controller.getStats().pokes).toBe(1);
    expect(triggerCount()).toBe(2); // backfill + poke
  });

  test('rapid pokes coalesce into the single-flight loop — never a parallel cycle (api/01-sync §6)', () => {
    const loop = new SingleFlightLoop();
    const { deps, ws } = makeDeps({ trigger: () => loop.requestSync() });
    const controller = new RealtimeController(deps);
    controller.start();
    ws.last.cb.onOpen(); // backfill → cycle 1 (busy)
    ws.last.cb.onMessage(POKE_FRAME);
    ws.last.cb.onMessage(POKE_FRAME);
    ws.last.cb.onMessage(POKE_FRAME);
    expect(loop.cycles).toBe(1); // one cycle, not four
    expect(loop.reruns).toBe(3); // the rapid pokes folded into rerun, no parallel loop
  });

  test('unknown type, malformed JSON, and binary frames are ignored + counted, never thrown', () => {
    const { deps, ws, triggerCount } = makeDeps();
    const controller = new RealtimeController(deps);
    controller.start();
    ws.last.cb.onOpen();
    const triggersAfterConnect = triggerCount();

    expect(() => {
      ws.last.cb.onMessage(JSON.stringify({ type: 'server.hello', payload: {} })); // unknown type
      ws.last.cb.onMessage('{ not json');
      ws.last.cb.onMessage(new Uint8Array([1, 2, 3])); // binary
      ws.last.cb.onMessage(new ArrayBuffer(4)); // binary
    }).not.toThrow();

    const stats = controller.getStats();
    expect(stats.droppedUnknown).toBe(1);
    expect(stats.droppedMalformed).toBe(1);
    expect(stats.droppedBinary).toBe(2);
    expect(stats.pokes).toBe(0);
    expect(triggerCount()).toBe(triggersAfterConnect); // none of the junk triggered a pull
  });

  test('connect and reconnect each fire one backfill (missed pokes cost latency only)', () => {
    const { deps, ws, timer } = makeDeps();
    const controller = new RealtimeController(deps);
    controller.start();
    ws.last.cb.onOpen(); // backfill 1
    ws.last.cb.onClose(); // drop → reconnect scheduled
    timer.advance(SYNC_BACKOFF_SCHEDULE_MS[0]); // reconnect fires → new ws.open
    ws.last.cb.onOpen(); // backfill 2
    expect(controller.getStats().backfills).toBe(2);
  });
});

describe('RealtimeController — fallback ladder (api/00 §12.3)', () => {
  test('3 consecutive WS connect failures → SSE; reconnect delays follow the sync backoff (5 s, 15 s)', () => {
    const { deps, ws, sse, timer } = makeDeps();
    const controller = new RealtimeController(deps);
    controller.start();
    expect(ws.count).toBe(1);

    ws.last.cb.onError(); // failure 1
    expect(timer.scheduled.at(-1)).toBe(SYNC_BACKOFF_SCHEDULE_MS[0]); // 5 s
    timer.advance(SYNC_BACKOFF_SCHEDULE_MS[0]);
    expect(ws.count).toBe(2);

    ws.last.cb.onError(); // failure 2
    expect(timer.scheduled.at(-1)).toBe(SYNC_BACKOFF_SCHEDULE_MS[1]); // 15 s
    timer.advance(SYNC_BACKOFF_SCHEDULE_MS[1]);
    expect(ws.count).toBe(3);

    ws.last.cb.onError(); // failure 3 → escalate to SSE (opened immediately)
    expect(controller.state.rung).toBe('sse');
    expect(sse.count).toBe(1);
  });

  test('3 consecutive SSE connect failures → polling-only (no active transport)', () => {
    const { deps, ws, sse, timer } = makeDeps();
    const controller = new RealtimeController(deps);
    controller.start();
    for (let i = 0; i < 3; i += 1) {
      ws.last.cb.onError();
      if (i < 2) timer.advance(SYNC_BACKOFF_SCHEDULE_MS[i] ?? 0);
    }
    expect(controller.state.rung).toBe('sse');

    // Now fail SSE three times.
    sse.last.cb.onError();
    timer.advance(SYNC_BACKOFF_SCHEDULE_MS[0]);
    sse.last.cb.onError();
    timer.advance(SYNC_BACKOFF_SCHEDULE_MS[1]);
    sse.last.cb.onError(); // 3rd → polling
    expect(controller.state.rung).toBe('polling');
    expect(controller.state.connected).toBe(false);
  });

  test('degraded → the 5-minute WS probe promotes on success, tears down the lower rung, resets counters', () => {
    const { deps, ws, sse, timer } = makeDeps();
    const controller = new RealtimeController(deps);
    controller.start();
    // Drive to SSE.
    ws.last.cb.onError();
    timer.advance(SYNC_BACKOFF_SCHEDULE_MS[0]);
    ws.last.cb.onError();
    timer.advance(SYNC_BACKOFF_SCHEDULE_MS[1]);
    ws.last.cb.onError();
    expect(controller.state.rung).toBe('sse');
    sse.last.cb.onOpen(); // SSE is the working lower rung
    const sseHandle = sse.last;
    const wsOpensBefore = ws.count;
    const backfillsBefore = controller.getStats().backfills;

    // The 5-minute WS recovery probe fires and connects.
    timer.advance(DEGRADED_WS_RETRY_MS);
    expect(ws.count).toBe(wsOpensBefore + 1); // a WS probe was opened
    ws.last.cb.onOpen(); // WS recovered → promote

    expect(controller.state.rung).toBe('ws');
    expect(controller.state.connected).toBe(true);
    expect(sseHandle.closed).toBe(true); // lower rung torn down
    expect(controller.getStats().backfills).toBe(backfillsBefore + 1); // promotion is a (re)connect
  });
});

describe('RealtimeController — FR-1146: realtime never gates sync', () => {
  test('in polling (both transports down), NO controller timer ever fires a trigger', () => {
    const { deps, ws, sse, timer, triggerCount } = makeDeps();
    const controller = new RealtimeController(deps);
    controller.start();

    // Drive WS→SSE→polling with every attempt failing.
    ws.last.cb.onError();
    timer.advance(SYNC_BACKOFF_SCHEDULE_MS[0]);
    ws.last.cb.onError();
    timer.advance(SYNC_BACKOFF_SCHEDULE_MS[1]);
    ws.last.cb.onError(); // → sse
    sse.last.cb.onError();
    timer.advance(SYNC_BACKOFF_SCHEDULE_MS[0]);
    sse.last.cb.onError();
    timer.advance(SYNC_BACKOFF_SCHEDULE_MS[1]);
    sse.last.cb.onError(); // → polling
    expect(controller.state.rung).toBe('polling');

    const triggersAtPolling = triggerCount();
    // Advance through MANY 5-minute WS-recovery cycles, each probe failing to connect.
    for (let i = 0; i < 12; i += 1) {
      timer.advance(DEGRADED_WS_RETRY_MS);
      // The recovery probe (a WS open) fails to connect — no onOpen, so no backfill trigger.
      const probe = ws.last;
      probe.cb.onError();
    }
    // The controller owns NO pull cadence: not one trigger fired from a timer. Only a genuine
    // connect (which never happened here) would — the 60 s periodic sync trigger does the polling.
    expect(triggerCount()).toBe(triggersAtPolling);
  });
});
