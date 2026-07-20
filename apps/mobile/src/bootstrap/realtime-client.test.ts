// THE RN REALTIME ADAPTERS, COMPOSED WITH THE SYNC LOOP (task 105) — the activation this task exists
// for. Task 20 shipped + falsified the platform-free `RealtimeController` (@bolusi/core/realtime) and
// the server WS/SSE poke hub under fakes, but explicitly deferred the RN socket/fetch adapters, so the
// app got NO pokes. This suite composes the APP's realtime the way boot does — the REAL controller +
// the REAL RN adapter seam (with a fake `WebSocket` / fake streamed `fetch`, ZERO sockets, T-6) + the
// REAL task-15 `SyncLoop` over a real better-sqlite3 DB — and proves a `sync.poke` delivered through
// that seam fires the loop's trigger (one pull, single-flight), that the bearer travels AT CONNECT in
// a header and never a query string (SEC-RT-01), and that with realtime DOWN the 60 s periodic trigger
// still converges (FR-1146 — realtime is purely additive).
import { readSyncState, type RealtimeController } from '@bolusi/core';
import { closeClientDb, openClientDb, runClientMigrations, type ClientDb } from '@bolusi/db-client';
import type { PullRequest, PullResponse, PushRequest, PushResponse } from '@bolusi/schemas';
import { noblePort } from '@bolusi/test-support';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { openBetterSqlite3Driver } from '../../test/better-sqlite3-driver.js';
import {
  createRealtimeController,
  createRnRealtimeTransports,
  type RealtimeSocketCtor,
} from './realtime-client.js';
import { createSyncClient, type SyncClientDeps } from './sync-client.js';

const T = 1_726_000_000_000;
const DEVICE_ID = '00000000-0000-4000-8000-0000000000ab';
const BASE_URL = 'https://sync.example';
const TOKEN = 'bdt_secrettoken';
const clockT = { now: () => T };

/** A `TimerPort`/`RuntimeTimerPort` that RECORDS scheduled callbacks and fires them on demand by delay
 *  (never on wall-clock time — T-6). One instance is shared by the loop backoff, the §5 triggers, and
 *  the realtime ladder, exactly as the app shares `systemTimer`. */
class FiringTimer {
  private readonly scheduled: { delayMs: number; fn: () => void; live: boolean }[] = [];
  schedule(delayMs: number, fn: () => void): () => void {
    const entry = { delayMs, fn, live: true };
    this.scheduled.push(entry);
    return () => {
      entry.live = false;
    };
  }
  /** Fire every currently-live callback scheduled at exactly `delayMs` (once each). */
  fire(delayMs: number): void {
    for (const entry of [...this.scheduled]) {
      if (entry.live && entry.delayMs === delayMs) {
        entry.live = false;
        entry.fn();
      }
    }
  }
}

/** A scripted transport (zero sockets). `pull` is always issued when a cycle runs, so its call count is
 *  the reliable "a cycle ran" signal for a device with no local ops (push.ts returns early on empty). */
class FakeTransport {
  readonly pulls: PullRequest[] = [];
  push(request: PushRequest): Promise<PushResponse> {
    void request;
    return Promise.resolve({ results: [], serverTime: T });
  }
  pull(request: PullRequest): Promise<PullResponse> {
    this.pulls.push(request);
    return Promise.resolve({ ops: [], nextCursor: request.cursor, hasMore: false, serverTime: T });
  }
}

/** A fake RN `WebSocket`: records the constructor args (SEC-RT-01 asserts the URL + header), and lets a
 *  test drive the lifecycle callbacks the adapter wires. ZERO real sockets. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(
    readonly url: string,
    readonly protocols: string | string[] | null | undefined,
    readonly options: { headers: Record<string, string> },
  ) {
    FakeWebSocket.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
  simulateOpen(): void {
    this.onopen?.();
  }
  simulateMessage(data: unknown): void {
    this.onmessage?.({ data });
  }
  simulateError(): void {
    this.onerror?.({});
  }
}

/** A fake `NetInfoPort` — fires immediately with the current state (NetInfo's contract). */
function fakeNetInfo(initial: boolean) {
  let connected = initial;
  const listeners = new Set<(c: boolean) => void>();
  return {
    port: {
      subscribe: (listener: (c: boolean) => void) => {
        listeners.add(listener);
        listener(connected);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    emit(next: boolean) {
      connected = next;
      for (const listener of listeners) listener(next);
    },
  };
}

/** A foregrounded `AppStatePort` with no transitions. */
const activeAppState = {
  current: () => 'active' as const,
  subscribe: () => () => undefined,
};

/** Drain the microtasks the async `open` scheduled (per-connect token read + stream reads). Not a
 *  sleep (T-6) — just letting resolved promises settle so the fake socket/stream exists. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

let db: ClientDb;

beforeEach(async () => {
  await closeClientDb();
  FakeWebSocket.instances = [];
  db = await openClientDb({
    driverFactory: openBetterSqlite3Driver,
    keyStore: { getDatabaseEncryptionKey: () => Promise.resolve('a'.repeat(64)) },
    location: ':memory:',
  });
  await runClientMigrations(db.driver, { now: () => 1 });
});

afterEach(async () => {
  await closeClientDb();
});

interface Built {
  readonly client: ReturnType<typeof createSyncClient>;
  readonly transport: FakeTransport;
  readonly controller: RealtimeController;
  readonly timer: FiringTimer;
  readonly net: ReturnType<typeof fakeNetInfo>;
}

async function build(options: { online?: boolean } = {}): Promise<Built> {
  const transport = new FakeTransport();
  const timer = new FiringTimer();
  const net = fakeNetInfo(options.online ?? false);
  let controller: RealtimeController | null = null;

  const deps: SyncClientDeps = {
    db,
    deviceId: DEVICE_ID,
    transport,
    bundle: { refresh: () => Promise.resolve('unchanged') },
    applyPulledOp: () => Promise.resolve(),
    crypto: noblePort,
    clock: clockT,
    timer,
    appState: activeAppState,
    netInfo: net.port,
    initialSyncState: await readSyncState(db.db),
    // The REAL adapter seam, exactly as `createSyncClientForApp` wires it — only the `WebSocket`
    // constructor is a fake (bearer-at-connect, zero sockets).
    createRealtime: (trigger) => {
      controller = createRealtimeController({
        baseUrl: BASE_URL,
        loadDeviceToken: () => Promise.resolve(TOKEN),
        trigger,
        clock: clockT,
        timer,
        webSocketImpl: FakeWebSocket as unknown as RealtimeSocketCtor,
      });
      return controller;
    },
  };
  const client = createSyncClient(deps);
  await client.start();
  await flush();
  if (controller === null) throw new Error('createRealtime was never invoked — realtime not wired');
  return { client, transport, controller, timer, net };
}

function lastSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1);
  if (socket === undefined) throw new Error('no WebSocket was constructed by the adapter');
  return socket;
}

describe('the RN realtime adapters compose with the sync loop (task 105 acceptance)', () => {
  test('a WS sync.poke frame drives the sync-loop trigger — one pull through the REAL adapter seam', async () => {
    const { client, transport, controller } = await build();
    const ws = lastSocket();

    ws.simulateOpen(); // (re)connect → the controller fires ONE backfill trigger
    await client.settle();
    const afterConnect = transport.pulls.length;
    expect(afterConnect).toBeGreaterThan(0);
    expect(controller.getStats().backfills).toBe(1);

    ws.simulateMessage('{"type":"sync.poke","payload":{}}');
    await client.settle();
    expect(transport.pulls.length).toBeGreaterThan(afterConnect); // the poke pulled
    expect(controller.getStats().pokes).toBe(1);
    client.stop();
  });

  test('the WS upgrade carries the device bearer AT CONNECT in a header, never a query-string token (SEC-RT-01)', async () => {
    const { client } = await build();
    const ws = lastSocket();

    // Bearer at connect, in the request header RN passes on the upgrade.
    expect(ws.options.headers['Authorization']).toBe(`Bearer ${TOKEN}`);
    // The token is NOT in the URL / query string (api/00 §3; SEC-RT-01).
    expect(ws.url).toBe('wss://sync.example/v1/realtime');
    expect(ws.url).not.toContain(TOKEN);
    expect(ws.url).not.toContain('?');
    client.stop();
  });

  test('no device token → the socket is never opened (fail closed, SEC-RT-01) — reported as a connect failure', async () => {
    // Tested at the adapter seam: an unauthenticated upgrade must never be attempted. The `ws` factory
    // reads the token PER CONNECT; a `null` token yields NO socket and an `onError` (which the controller
    // counts as a WS connect failure and walks the ladder from), exactly as a 401 would.
    const { ws } = createRnRealtimeTransports({
      baseUrl: BASE_URL,
      loadDeviceToken: () => Promise.resolve(null), // no token yet
      webSocketImpl: FakeWebSocket as unknown as RealtimeSocketCtor,
    });
    let errors = 0;
    const handle = ws.open({
      onOpen: () => undefined,
      onMessage: () => undefined,
      onError: () => {
        errors += 1;
      },
      onClose: () => undefined,
    });
    await flush();

    expect(FakeWebSocket.instances).toHaveLength(0); // no unauthenticated socket was ever constructed
    expect(errors).toBe(1); // the controller sees a connect failure, never an open socket
    handle.close();
  });

  test('rapid pokes coalesce into the single-flight loop — never a parallel cycle', async () => {
    const { client, transport, controller } = await build();
    const ws = lastSocket();
    ws.simulateOpen();
    await client.settle();
    const baseline = transport.pulls.length;

    // Three pokes with NO settle between them: the loop's single-flight coalesces concurrent triggers
    // into the one in-flight cycle (api/01-sync §6) — a rerun flag, not a counter, so it never spins up
    // parallel cycles.
    ws.simulateMessage('{"type":"sync.poke","payload":{}}');
    ws.simulateMessage('{"type":"sync.poke","payload":{}}');
    ws.simulateMessage('{"type":"sync.poke","payload":{}}');
    await client.settle();

    expect(controller.getStats().pokes).toBe(3); // all three were seen
    // …but they collapsed: far fewer than 3 pulls, and the loop drained back to idle (no parallel run).
    expect(transport.pulls.length - baseline).toBeLessThan(3);
    expect(transport.pulls.length - baseline).toBeGreaterThan(0);
    expect(client.state()).toBe('idle');
    client.stop();
  });

  test('a non-poke / unknown WS frame is ignored — no pull, no throw', async () => {
    const { client, transport, controller } = await build();
    const ws = lastSocket();
    ws.simulateOpen();
    await client.settle();
    const baseline = transport.pulls.length;

    ws.simulateMessage('{"type":"something.else","payload":{}}'); // unknown type
    ws.simulateMessage('not json at all'); // malformed
    await client.settle();

    expect(transport.pulls.length).toBe(baseline); // nothing triggered a pull
    expect(controller.getStats().pokes).toBe(0);
    expect(controller.getStats().droppedUnknown).toBe(1);
    expect(controller.getStats().droppedMalformed).toBe(1);
    client.stop();
  });
});

describe('FR-1146 — realtime DOWN, the 60 s periodic trigger still converges (realtime is purely additive)', () => {
  test('both the WS connect and the periodic tick prove the down-path: zero realtime triggers, yet the periodic syncs', async () => {
    // Boot OFFLINE so no connectivity cycle runs, and drive the WS to fail to connect — the controller
    // counts a connect failure and delivers NO backfill/poke trigger. Realtime contributes nothing.
    const { client, transport, controller, timer } = await build({ online: false });
    const ws = lastSocket();
    ws.simulateError(); // WS never opened → connect failure; no trigger ever fired from realtime
    await client.settle();

    expect(controller.getStats().backfills).toBe(0);
    expect(controller.getStats().pokes).toBe(0);
    expect(transport.pulls.length).toBe(0); // nothing has synced yet
    expect((await readSyncState(db.db)).lastSuccessfulSyncAt).toBeNull();

    // The 60 s periodic tick (api/01-sync §5c) fires — the ONLY converging trigger here — and the device
    // syncs regardless of the dead realtime channel. Correctness never depended on realtime.
    timer.fire(60_000);
    await client.settle();

    expect(transport.pulls.length).toBeGreaterThan(0);
    expect((await readSyncState(db.db)).lastSuccessfulSyncAt).toBe(T);
    // Still zero realtime triggers — the convergence came entirely from the periodic path.
    expect(controller.getStats().backfills).toBe(0);
    expect(controller.getStats().pokes).toBe(0);
    client.stop();
  });
});

describe('the SSE reader reconstructs the WS-frame shape the controller consumes', () => {
  /** A fake streaming `fetch` returning a 200 `text/event-stream` whose body emits `chunks`. */
  function sseFetch(chunks: string[]): typeof fetch {
    return (() => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );
    }) as unknown as typeof fetch;
  }

  async function drainSse(chunks: string[]): Promise<{ messages: unknown[]; opened: number }> {
    const { sse } = createRnRealtimeTransports({
      baseUrl: BASE_URL,
      loadDeviceToken: () => Promise.resolve(TOKEN),
      sseFetchImpl: sseFetch(chunks),
    });
    const messages: unknown[] = [];
    let opened = 0;
    const handle = sse.open({
      onOpen: () => {
        opened += 1;
      },
      onMessage: (data) => messages.push(data),
      onError: () => undefined,
      onClose: () => undefined,
    });
    await flush();
    handle.close();
    return { messages, opened };
  }

  test('an `event: sync.poke` / `data: {}` SSE event becomes the frozen WS poke frame', async () => {
    const { messages, opened } = await drainSse(['event: sync.poke\ndata: {}\n\n']);
    expect(opened).toBe(1);
    expect(messages).toContain('{"type":"sync.poke","payload":{}}');
  });

  test('a heartbeat comment carries no data and is not forwarded', async () => {
    const { messages } = await drainSse([': hb\n\n', 'event: sync.poke\ndata: {}\n\n']);
    // Only the poke — the `: hb` heartbeat produced nothing.
    expect(messages).toEqual(['{"type":"sync.poke","payload":{}}']);
  });
});
