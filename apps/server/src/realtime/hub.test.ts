// Realtime hub unit tests (api/00 §12.1; api/01-sync §4.3). The hub is the transport-agnostic core:
// scope routing (SEC-RT-04), coalescing, keepalive, single-connection-per-device, closeForDevice
// (SEC-RT-02), client-frame flood-close (SEC-RT-05), and leak-freedom. Driven with fake connections
// + a virtual scheduler/clock so time is exact and nothing sleeps (testing-guide T-6).
import { describe, expect, test } from 'vitest';

import {
  DEFAULT_MAX_CLIENT_MESSAGES,
  RealtimeHub,
  SSE_HEARTBEAT_INTERVAL_MS,
  WS_PING_INTERVAL_MS,
  scopeMatchesConnection,
  type HubScheduler,
  type RealtimeConnection,
} from './hub.js';

/** A virtual clock + one-shot scheduler. `advance` fires due timers in order, honouring the
 *  self-rescheduling keepalive (each fire may enqueue another timer). */
class FakeTime {
  ms = 0;
  #timers: { at: number; fn: () => void; live: boolean }[] = [];
  now = (): number => this.ms;
  scheduler: HubScheduler = {
    setTimer: (delayMs, fn) => {
      const timer = { at: this.ms + delayMs, fn, live: true };
      this.#timers.push(timer);
      return {
        cancel: () => {
          timer.live = false;
        },
      };
    },
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

interface FakeConn extends RealtimeConnection {
  pokes: number;
  probes: number;
  closed: number;
}

function fakeConn(fields: {
  deviceId: string;
  tenantId: string;
  storeId: string | null;
  tracksLiveness?: boolean;
  heartbeatIntervalMs?: number;
}): FakeConn {
  const conn: FakeConn = {
    deviceId: fields.deviceId,
    tenantId: fields.tenantId,
    storeId: fields.storeId,
    tracksLiveness: fields.tracksLiveness ?? true,
    heartbeatIntervalMs: fields.heartbeatIntervalMs ?? WS_PING_INTERVAL_MS,
    pokes: 0,
    probes: 0,
    closed: 0,
    emitPoke() {
      conn.pokes += 1;
    },
    probe() {
      conn.probes += 1;
    },
    close() {
      conn.closed += 1;
    },
  };
  return conn;
}

function makeHub(
  time: FakeTime,
  opts: Partial<{
    coalesceWindowMs: number;
    maxMissedPongs: number;
    maxClientMessages: number;
  }> = {},
) {
  return new RealtimeHub({ now: time.now, scheduler: time.scheduler, ...opts });
}

describe('scopeMatchesConnection (api/01-sync §4.3 pull scope = fan-out scope)', () => {
  const conn = fakeConn({ deviceId: 'd', tenantId: 'A', storeId: 'store1' });

  test('same tenant + same store matches', () => {
    expect(scopeMatchesConnection({ tenantId: 'A', storeId: 'store1' }, conn)).toBe(true);
  });
  test('same tenant + tenant-scoped (storeId null) matches', () => {
    expect(scopeMatchesConnection({ tenantId: 'A', storeId: null }, conn)).toBe(true);
  });
  test('same tenant + OTHER store does not match', () => {
    expect(scopeMatchesConnection({ tenantId: 'A', storeId: 'store2' }, conn)).toBe(false);
  });
  test('OTHER tenant never matches — not even a tenant-scoped poke', () => {
    expect(scopeMatchesConnection({ tenantId: 'B', storeId: 'store1' }, conn)).toBe(false);
    expect(scopeMatchesConnection({ tenantId: 'B', storeId: null }, conn)).toBe(false);
  });
});

describe('RealtimeHub.pokeAccepted — scope routing (SEC-RT-04 core)', () => {
  test('store-scoped poke reaches only its store; tenant poke reaches the whole tenant; tenant B never', () => {
    const time = new FakeTime();
    const hub = makeHub(time);
    const aStore1 = fakeConn({ deviceId: 'a1', tenantId: 'A', storeId: 'store1' });
    const aStore2 = fakeConn({ deviceId: 'a2', tenantId: 'A', storeId: 'store2' });
    const bStore1 = fakeConn({ deviceId: 'b1', tenantId: 'B', storeId: 'store1' }); // zero-relationship control
    hub.register(aStore1);
    hub.register(aStore2);
    hub.register(bStore1);

    hub.pokeAccepted({ tenantId: 'A', storeId: 'store1' });
    expect(aStore1.pokes).toBe(1);
    expect(aStore2.pokes).toBe(0);
    expect(bStore1.pokes).toBe(0);

    // Advance past the coalescing window so the next distinct poke emits, not coalesces.
    time.advance(2_000);
    hub.pokeAccepted({ tenantId: 'A', storeId: null });
    expect(aStore1.pokes).toBe(2);
    expect(aStore2.pokes).toBe(1);
    // The control device in tenant B heard NOTHING across either poke.
    expect(bStore1.pokes).toBe(0);
  });
});

describe('RealtimeHub — coalescing (≤1 poke/connection/second, api/00 §12.1)', () => {
  test('a burst of 3 pokes at the same instant yields exactly one frame', () => {
    const time = new FakeTime();
    const hub = makeHub(time);
    const conn = fakeConn({ deviceId: 'd', tenantId: 'A', storeId: 's' });
    hub.register(conn);
    hub.pokeAccepted({ tenantId: 'A', storeId: 's' });
    hub.pokeAccepted({ tenantId: 'A', storeId: 's' });
    hub.pokeAccepted({ tenantId: 'A', storeId: 's' });
    expect(conn.pokes).toBe(1);
  });

  test('a poke suppressed inside the window flushes once at the window edge (trailing)', () => {
    const time = new FakeTime();
    const hub = makeHub(time);
    const conn = fakeConn({ deviceId: 'd', tenantId: 'A', storeId: 's' });
    hub.register(conn);
    hub.pokeAccepted({ tenantId: 'A', storeId: 's' }); // leading emit
    time.advance(300);
    hub.pokeAccepted({ tenantId: 'A', storeId: 's' }); // suppressed, trailing scheduled
    expect(conn.pokes).toBe(1);
    time.advance(700); // reach the 1 s edge
    expect(conn.pokes).toBe(2);
  });
});

describe('RealtimeHub — keepalive (api/00 §12.1/§12.2)', () => {
  test('WS: ping every 30 s; 2 missed pongs → close', () => {
    const time = new FakeTime();
    const hub = makeHub(time);
    const conn = fakeConn({ deviceId: 'd', tenantId: 'A', storeId: 's', tracksLiveness: true });
    hub.register(conn);
    time.advance(WS_PING_INTERVAL_MS); // tick 1: ping
    expect(conn.probes).toBe(1);
    expect(conn.closed).toBe(0);
    time.advance(WS_PING_INTERVAL_MS); // tick 2: ping (2 unanswered)
    expect(conn.probes).toBe(2);
    expect(conn.closed).toBe(0);
    time.advance(WS_PING_INTERVAL_MS); // tick 3: 2 missed → close
    expect(conn.closed).toBe(1);
    expect(hub.connectionCount).toBe(0);
  });

  test('WS: a pong each cycle keeps the socket open indefinitely', () => {
    const time = new FakeTime();
    const hub = makeHub(time);
    const conn = fakeConn({ deviceId: 'd', tenantId: 'A', storeId: 's', tracksLiveness: true });
    const reg = hub.register(conn);
    for (let i = 0; i < 10; i += 1) {
      time.advance(WS_PING_INTERVAL_MS);
      reg.notifyPong();
    }
    expect(conn.closed).toBe(0);
    expect(hub.connectionCount).toBe(1);
  });

  test('SSE: emits a heartbeat every 25 s and is never closed for liveness (no pong)', () => {
    const time = new FakeTime();
    const hub = makeHub(time);
    const conn = fakeConn({
      deviceId: 'd',
      tenantId: 'A',
      storeId: 's',
      tracksLiveness: false,
      heartbeatIntervalMs: SSE_HEARTBEAT_INTERVAL_MS,
    });
    hub.register(conn);
    time.advance(SSE_HEARTBEAT_INTERVAL_MS * 5);
    expect(conn.probes).toBe(5);
    expect(conn.closed).toBe(0);
  });
});

describe('RealtimeHub — lifecycle', () => {
  test('single connection per device: a second register closes the first', () => {
    const time = new FakeTime();
    const hub = makeHub(time);
    const first = fakeConn({ deviceId: 'dev', tenantId: 'A', storeId: 's' });
    const second = fakeConn({ deviceId: 'dev', tenantId: 'A', storeId: 's' });
    hub.register(first);
    hub.register(second);
    expect(first.closed).toBe(1);
    expect(hub.connectionCount).toBe(1);
    hub.pokeAccepted({ tenantId: 'A', storeId: 's' });
    expect(first.pokes).toBe(0);
    expect(second.pokes).toBe(1);
  });

  test('closeForDevice closes the live socket and clears it (SEC-RT-02 mechanism)', () => {
    const time = new FakeTime();
    const hub = makeHub(time);
    const conn = fakeConn({ deviceId: 'dev', tenantId: 'A', storeId: 's' });
    hub.register(conn);
    hub.closeForDevice('dev');
    expect(conn.closed).toBe(1);
    expect(hub.connectionCount).toBe(0);
    hub.pokeAccepted({ tenantId: 'A', storeId: 's' });
    expect(conn.pokes).toBe(0); // gone — no poke after close
  });

  test('registry returns to baseline after dispose / repeated pokes leave no leak', () => {
    const time = new FakeTime();
    const hub = makeHub(time);
    expect(hub.connectionCount).toBe(0);
    const conn = fakeConn({ deviceId: 'dev', tenantId: 'A', storeId: 's' });
    const reg = hub.register(conn);
    for (let i = 0; i < 5; i += 1) hub.pokeAccepted({ tenantId: 'A', storeId: 's' });
    reg.dispose();
    expect(hub.connectionCount).toBe(0);
    reg.dispose(); // idempotent
    expect(hub.connectionCount).toBe(0);
  });
});

describe('RealtimeHub — client frame hardening (SEC-RT-05 mechanism)', () => {
  test('client frames are counted; a flood past the cap closes the socket', () => {
    const time = new FakeTime();
    const hub = makeHub(time, { maxClientMessages: DEFAULT_MAX_CLIENT_MESSAGES });
    const conn = fakeConn({ deviceId: 'dev', tenantId: 'A', storeId: 's' });
    const reg = hub.register(conn);
    for (let i = 0; i < DEFAULT_MAX_CLIENT_MESSAGES; i += 1) reg.notifyClientMessage();
    expect(conn.closed).toBe(0); // at the cap: still healthy
    reg.notifyClientMessage(); // one past the cap
    expect(conn.closed).toBe(1);
    expect(hub.connectionCount).toBe(0);
  });
});
