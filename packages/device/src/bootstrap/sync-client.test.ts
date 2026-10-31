// THE SYNC CLIENT (task 89) — the acceptance this whole task exists for.
//
// An ENROLLED device's persisted state (a `deviceId`, the seeded `sync_state`, any local ops) is
// given to `createSyncClient`, and the REAL `SyncLoop` (task 15) runs end-to-end against a FAKE
// transport with a FAKE timer and ZERO sockets (T-6: a test that sleeps is a bug). The load-bearing
// assertion is T-19: after the first cycle `lastSuccessfulSyncAt` is a REAL timestamp READ FROM
// `sync_state` — never `?? Date.now()`, never a literal — so the never-connected banner clears.
//
// WHAT THIS PROVES, PRECISELY: the loop, GIVEN an enrolled device's persisted state. A production
// device now REACHES that state through the enrollment composition (task 92, `enrollment.test.ts`);
// this file is still the sync-loop lane, so it starts from the persisted state rather than producing
// it. The falsifications below break each wiring (bundle, transport, the connectivity trigger) and
// watch the cycle fail LOUDLY (§2.11).
import {
  insertOpLogRow,
  InvalidationBus,
  OP_SYNC_STATUS_TABLE,
  readSyncState,
  stalenessLevel,
  SYNC_BACKOFF_SCHEDULE_MS,
  SyncTransportError,
  type TimerPort,
} from '@bolusi/core';
import { closeClientDb, openClientDb, runClientMigrations, type ClientDb } from '@bolusi/db-client';
import type {
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
  SignedOperation,
} from '@bolusi/schemas';
import { ChainBuilder, makeWorld, noblePort, nodeColumnAead, opRowOf } from '@bolusi/test-support';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { openBetterSqlite3Driver } from '../../test/better-sqlite3-driver.js';
import { FakeTimer } from '../media/_harness.test.js';
import { fakeBackgroundPlatform } from './_background-platform.test.js';
import { SYNC_BACKGROUND_TASK } from './background-sync.js';
import { createBackgroundHost, type BackgroundBinding } from './background-task.js';
import type { Bootstrapped } from './bootstrap.js';
import {
  createSyncClient,
  createSyncClientForApp,
  knowsOp,
  type SyncClientDeps,
} from './sync-client.js';
import { APPEND_DEBOUNCE_MS } from './triggers.js';

const KEY = 'a'.repeat(64);
const keyStore = { getDatabaseEncryptionKey: () => Promise.resolve(KEY) };
const T = 1_726_000_000_000;
const DEVICE_ID = '00000000-0000-4000-8000-0000000000ab';

/** A `TimerPort` that RECORDS but never fires — the happy path arms no backoff, and a failed cycle's
 *  backoff is asserted by the loop STATE ('backoff'), never by advancing wall-clock time (T-6). */
class RecordingTimer {
  scheduled = 0;
  // Fewer params than `TimerPort.schedule` is assignable (and avoids unused-var lint): this fake
  // never fires, so it needs neither the delay nor the callback.
  schedule(): () => void {
    this.scheduled += 1;
    return () => undefined;
  }
}

/** A scripted transport (zero sockets). Records requests; `*Rejects` makes a leg fail like the wire.
 *  NOTE push is SKIPPED on an empty local batch (push.ts returns before the transport call), so `pull`
 *  — always issued when a cycle runs — is the reliable "a cycle ran" signal for a device with no ops. */
class FakeTransport {
  readonly pushes: PushRequest[] = [];
  readonly pulls: PullRequest[] = [];
  pushRejects = false;
  pullRejects = false;
  /** Pages served in order before the drained steady state. */
  readonly pullPages: PullResponse[] = [];
  push(request: PushRequest): Promise<PushResponse> {
    this.pushes.push(request);
    if (this.pushRejects) {
      return Promise.reject(
        new SyncTransportError('server down', { code: 'INTERNAL', status: 503 }),
      );
    }
    return Promise.resolve({ results: [], serverTime: T });
  }
  pull(request: PullRequest): Promise<PullResponse> {
    this.pulls.push(request);
    if (this.pullRejects) {
      return Promise.reject(
        new SyncTransportError('server down', { code: 'INTERNAL', status: 503 }),
      );
    }
    const page = this.pullPages.shift();
    if (page !== undefined) return Promise.resolve(page);
    return Promise.resolve({ ops: [], nextCursor: request.cursor, hasMore: false, serverTime: T });
  }
}

/** A fake `NetInfoPort` — fires immediately with the current state, then on `emit` (NetInfo contract). */
function fakeNetInfo(initial: boolean) {
  let connected = initial;
  const listeners = new Set<(c: boolean) => void>();
  let subscriptions = 0;
  return {
    /** How many times anything subscribed: the triggers and the UI mirror each do once on start. */
    subscriptions: () => subscriptions,
    port: {
      subscribe: (listener: (c: boolean) => void) => {
        subscriptions += 1;
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

/** A fake `AppStatePort`: foregrounded, no transitions. The interval arms but the RecordingTimer never
 *  fires it, so the only cycle driver in these tests is the connectivity trigger — exactly the seam
 *  under test. */
const activeAppState = {
  current: () => 'active' as const,
  subscribe: () => () => undefined,
};

let db: ClientDb;

beforeEach(async () => {
  await closeClientDb();
  db = await openClientDb({
    driverFactory: openBetterSqlite3Driver,
    keyStore,
    aead: nodeColumnAead,
    location: ':memory:',
  });
  await runClientMigrations(db.driver, { now: () => 1 });
});

afterEach(async () => {
  await closeClientDb();
});

/** Seed one `syncStatus='local'` op — a real row `readPushBatch` reconstructs (push.ts). */
async function seedLocalOp(opId: string): Promise<void> {
  const core = {
    id: opId,
    tenantId: 'tenant-1',
    storeId: 'store-1',
    userId: 'user-1',
    deviceId: DEVICE_ID,
    seq: 1,
    type: 'platform.user_locale_changed',
    entityType: 'device',
    entityId: DEVICE_ID,
    schemaVersion: 1,
    payload: { locale: 'id' },
    timestamp: T,
    location: null,
    source: 'system',
    agentInitiated: false,
    agentConversationId: null,
    previousHash: '0'.repeat(64),
  };
  const op = { ...core, hash: 'hh', signature: 'ss' } as SignedOperation;
  await insertOpLogRow(db.db, opRowOf(op), {
    syncStatus: 'local',
    syncedAt: null,
    arrivalSeq: null,
  });
}

const clockT = { now: () => T };

interface BuildOptions {
  readonly online?: boolean;
  readonly timer?: TimerPort;
  readonly bundleThrows?: boolean;
  readonly pushRejects?: boolean;
  readonly pullRejects?: boolean;
  readonly background?: BackgroundBinding;
}

async function build(options: BuildOptions = {}) {
  const transport = new FakeTransport();
  transport.pushRejects = options.pushRejects ?? false;
  transport.pullRejects = options.pullRejects ?? false;
  const timer = options.timer ?? new RecordingTimer();
  const net = fakeNetInfo(options.online ?? true);
  let bundleCalls = 0;
  const applied: SignedOperation[] = [];

  const deps: SyncClientDeps = {
    db,
    deviceId: DEVICE_ID,
    transport,
    bundle: {
      refresh: () => {
        bundleCalls += 1;
        if (options.bundleThrows) return Promise.reject(new Error('bundle endpoint down'));
        return Promise.resolve('unchanged'); // 304 — the steady state
      },
    },
    applyPulledOp: (op) => {
      applied.push(op);
      return Promise.resolve();
    },
    refoldRefused: () => Promise.resolve(),
    knowsOp: () => true,
    crypto: noblePort,
    clock: { now: () => T },
    timer,
    appState: activeAppState,
    netInfo: net.port,
    initialSyncState: await readSyncState(db.db),
    ...(options.background === undefined ? {} : { background: options.background }),
  };
  return { client: createSyncClient(deps), transport, timer, net, bundleCalls: () => bundleCalls };
}

/**
 * A store history of four signed ops, a day apart, served as two pages: what a new device pulls.
 * The devices sidecar on the first page lets every op verify.
 */
function historyPages(): PullResponse[] {
  const world = makeWorld(7, noblePort);
  const chain = new ChainBuilder(world, noblePort);
  const DAY = 86_400_000;
  const start = T - 4 * DAY;
  const ops = [0, 1, 2, 3].map((day) =>
    chain.append({
      type: 'notes.note_created',
      entityType: 'note',
      payload: { title: `n${day}`, body: '' },
      timestamp: start + day * DAY,
    }),
  );
  return [
    {
      ops: ops.slice(0, 2),
      nextCursor: 2,
      hasMore: true,
      serverTime: T,
      devices: [
        {
          id: world.deviceId,
          storeId: world.storeId,
          kind: 'member',
          signingKeyPublic: world.publicKeyB64,
          status: 'active',
          revokedAt: null,
        },
      ],
      devicesDirectoryVersion: 1,
    },
    { ops: ops.slice(2), nextCursor: 4, hasMore: false, serverTime: T },
  ];
}

describe('the sync client constructs, starts, and drives a REAL cycle (task 89 acceptance)', () => {
  test('an enrolled boot syncs: lastSuccessfulSyncAt becomes a REAL timestamp, banner de-escalates (T-19)', async () => {
    // Before: the seeded row's `last_successful_sync_at` is NULL, which 03 §8 maps to `stale`.
    expect((await readSyncState(db.db)).lastSuccessfulSyncAt).toBeNull();
    expect(stalenessLevel(await readSyncState(db.db), clockT)).toBe('stale');

    const { client, transport, bundleCalls } = await build({ online: true });
    await client.start(); // NetInfo reports online → the boot connectivity trigger drives a cycle
    await client.settle();

    // THE LINE THIS TASK EXISTS FOR: a real timestamp, read from the column — not null, not a default.
    const fresh = await readSyncState(db.db);
    expect(fresh.lastSuccessfulSyncAt).toBe(T);
    expect(client.syncState().lastSuccessfulSyncAt).toBe(T);
    // The banner clears: the staleness tier de-escalates off `stale`.
    expect(stalenessLevel(fresh, clockT)).not.toBe('stale');

    // A full cycle ran — pull is always issued, and the once-per-cycle bundle refresh fired. (Push is
    // skipped here: a fresh device has no local ops, so push.ts returns before the transport call.)
    expect(transport.pulls.length).toBeGreaterThan(0);
    expect(bundleCalls()).toBeGreaterThan(0);
    expect(client.state()).toBe('idle'); // drained back to idle (03 §10)
    client.stop();
  });

  test('a local op is CARRIED in the push request — the push half is wired to the log', async () => {
    await seedLocalOp('01920000-0000-7000-8000-0000000000aa');
    const { client, transport } = await build({ online: true });
    await client.start();
    await client.settle();

    const ids = transport.pushes.flatMap((p) => p.ops.map((op) => op.id));
    expect(ids).toContain('01920000-0000-7000-8000-0000000000aa');
    expect(transport.pushes[0]!.deviceId).toBe(DEVICE_ID);
    client.stop();
  });

  test('isOffline and state() are READ FROM THE LIVE INPUTS, not literals', async () => {
    const { client, net } = await build({ online: false });
    await client.start();
    await client.settle();
    // Booted offline: no connectivity trigger fired, so no cycle — the loop is idle and the device
    // reports offline from NetInfo (an INPUT), not from a guess.
    expect(client.isOffline()).toBe(true);
    expect(client.state()).toBe('idle');

    net.emit(true);
    await client.settle();
    expect(client.isOffline()).toBe(false); // connectivity is now a live fact
    client.stop();
  });

  test('subscribe fires on cycle completion — the signal Root re-reads SyncState on', async () => {
    const { client } = await build({ online: true });
    let notifications = 0;
    client.subscribe(() => {
      notifications += 1;
    });
    await client.start();
    await client.settle();
    expect(notifications).toBeGreaterThan(0);
    client.stop();
  });
});

describe('falsification — each wiring broken makes the cycle FAIL LOUDLY (§2.11)', () => {
  test('BREAK THE BUNDLE PORT: refresh() throws → cycle fails → NOT synced, loop in backoff', async () => {
    // This is also the 304-is-a-success control's opposite: normally refresh() resolves and the cycle
    // succeeds; when it throws, the whole cycle fails and lastSuccessfulSyncAt is never written. A
    // producer that (wrongly) threw on a real 304 would put a healthy device here on EVERY cycle.
    const { client } = await build({ online: true, bundleThrows: true });
    await client.start();
    await client.settle();

    expect((await readSyncState(db.db)).lastSuccessfulSyncAt).toBeNull();
    expect(client.syncState().lastSuccessfulSyncAt).toBeNull();
    expect(client.state()).toBe('backoff'); // loud: a backoff timer was armed (03 §10)
    client.stop();
  });

  test('BREAK THE TRANSPORT: pull rejects → cycle fails → NOT synced, loop in backoff', async () => {
    // Pull is always issued (push is skipped on an empty batch), so it is the clean transport-break
    // for a device with no local ops: a rejected pull is a LOOP failure → backoff (03 §10).
    const { client, transport } = await build({ online: true, pullRejects: true });
    await client.start();
    await client.settle();

    expect(transport.pulls.length).toBeGreaterThan(0); // it tried
    expect((await readSyncState(db.db)).lastSuccessfulSyncAt).toBeNull();
    expect(client.state()).toBe('backoff');
    client.stop();
  });

  test('BREAK THE TRIGGER: no connectivity signal → NO cycle → NOT synced (with a positive control)', async () => {
    // The connectivity trigger is what starts the loop on an enrolled boot. With no signal, nothing
    // runs — proving the trigger, not the loop, is the driver. Then a genuine connect DOES drive it.
    const { client, transport, net } = await build({ online: false });
    await client.start();
    await client.settle();
    expect(transport.pulls.length).toBe(0); // never started — a pull is issued on every cycle
    expect((await readSyncState(db.db)).lastSuccessfulSyncAt).toBeNull();

    // Positive control (T-14b): the trigger works; it simply had no signal. A real regain syncs.
    net.emit(true);
    await client.settle();
    expect(transport.pulls.length).toBeGreaterThan(0);
    expect((await readSyncState(db.db)).lastSuccessfulSyncAt).toBe(T);
    client.stop();
  });
});

describe('"Kirim sekarang" answers the press (round 2 QA, F11)', () => {
  test('sending shows at once, and a hung attempt that times out says it failed', async () => {
    const { client, transport } = await build({ online: true });
    await client.start();
    await client.settle();

    // The server stops answering: the pull hangs until the request deadline gives up.
    let giveUp: (error: Error) => void = () => undefined;
    transport.pull = (request) => {
      transport.pulls.push(request);
      return new Promise((_, reject) => {
        giveUp = reject;
      });
    };
    const seen: { state: string; busy: boolean; error: string | null }[] = [];
    client.subscribe(() => seen.push({ state: client.state(), ...client.manualSync() }));
    const pulled = transport.pulls.length;
    client.requestManual();
    // Told before any answer comes back: the screens show it is sending.
    expect(seen.at(-1)).toEqual({ state: 'pushing', busy: true, error: null });

    await vi.waitFor(() => expect(transport.pulls.length).toBe(pulled + 1));
    expect(client.state()).not.toBe('idle');
    giveUp(new SyncTransportError('no answer within 60000 ms', { code: null, status: null }));
    await vi.waitFor(() => expect(client.manualSync().busy).toBe(false));
    // No longer "sending": backed off, with a failure line for the press.
    expect(client.state()).toBe('backoff');
    expect(client.manualSync()).toEqual({ busy: false, error: 'NETWORK' });
    expect(seen.at(-1)).toEqual({ state: 'backoff', busy: false, error: 'NETWORK' });
    client.stop();
  });

  test('a press that gets through clears the failure line', async () => {
    const { client, transport } = await build({ online: true, pullRejects: true });
    await client.start();
    client.requestManual();
    await client.settle();
    await vi.waitFor(() => expect(client.manualSync().error).toBe('INTERNAL'));

    transport.pullRejects = false;
    client.requestManual();
    expect(client.manualSync()).toEqual({ busy: true, error: null });
    await vi.waitFor(() => expect(client.manualSync()).toEqual({ busy: false, error: null }));
    expect(client.state()).toBe('idle');
    client.stop();
  });
});

describe('a retry after a failed cycle', () => {
  test('tells the screens when it ends, though no trigger asked for it', async () => {
    const timer = new FakeTimer();
    const { client, transport } = await build({ online: true, pullRejects: true, timer });
    await client.start();
    await client.settle();
    expect(client.state()).toBe('backoff');

    // Only the subscription may tell the screens: they never poll the client.
    const told: string[] = [];
    client.subscribe(() => told.push(client.state()));
    transport.pullRejects = false;
    timer.runDelay(SYNC_BACKOFF_SCHEDULE_MS[0]);
    await vi.waitFor(() => expect(told.at(-1)).toBe('idle'));
    expect(client.syncState().lastSuccessfulSyncAt).toBe(T);
    client.stop();
  });
});

describe('the exposed `scheduler` IS §5 (b), on the client index.ts builds (task 136)', () => {
  /**
   * `createSyncClientForApp` is the function the composition root calls, and nothing exercised it —
   * which left the last link between "Root binds `client.scheduler`" and "the client a DEVICE gets
   * has a working one" unguarded. This drives that exact function and inspects what its `scheduler`
   * arms, against the EXPORTED constant rather than a literal (T-6).
   *
   * A timer that records DELAYS (the rest of this file uses one that records only counts): the whole
   * claim is "1 s, and re-armed, not queued", and a count cannot express either half.
   */
  function delayRecordingTimer() {
    const armed = new Map<number, number>();
    let nextId = 0;
    return {
      port: {
        schedule(delayMs: number): () => void {
          const id = (nextId += 1);
          armed.set(id, delayMs);
          return () => {
            armed.delete(id);
          };
        },
      },
      delays: () => [...armed.values()],
    };
  }

  async function clientForApp(timer: ReturnType<typeof delayRecordingTimer>) {
    const app = {
      db,
      engine: { applyPulledOp: () => Promise.resolve(), refoldRefused: () => Promise.resolve() },
      syncState: await readSyncState(db.db),
    } as unknown as Bootstrapped;
    return createSyncClientForApp(app, {
      baseUrl: 'https://example.invalid',
      deviceId: DEVICE_ID,
      loadDeviceToken: () => Promise.resolve('bdt_test'),
      crypto: noblePort,
      clock: clockT,
      appState: activeAppState,
      netInfo: fakeNetInfo(false).port,
      timer: timer.port,
      // Never called: nothing here fires a timer, so no cycle runs and no request is made. Injected
      // because the real default is the global `fetch`, and a test must not be able to reach a wire.
      fetchImpl: () => Promise.reject(new Error('no wire in this test')),
    });
  }

  test('one append arms ONE timer, at APPEND_DEBOUNCE_MS — not immediately, not the 60 s interval', async () => {
    const timer = delayRecordingTimer();
    const client = await clientForApp(timer);
    expect(timer.delays(), 'a client that has not started must arm nothing').toStrictEqual([]);

    client.scheduler.schedule();

    // The no-op this task removed would arm NOTHING here; a straight-through wiring would have run a
    // cycle instead of arming anything; the 60 s interval would be the wrong delay.
    expect(timer.delays()).toStrictEqual([APPEND_DEBOUNCE_MS]);
    client.stop();
  });

  test('a second append inside the window RE-ARMS rather than queues (the debounce)', async () => {
    const timer = delayRecordingTimer();
    const client = await clientForApp(timer);

    client.scheduler.schedule();
    client.scheduler.schedule();
    client.scheduler.schedule();

    // Still ONE armed timer: `schedule()` cancels the pending one before arming the next. Three
    // entries here would be a queue — 40 appends would then mean 40 cycles.
    expect(timer.delays()).toStrictEqual([APPEND_DEBOUNCE_MS]);
    client.stop();
  });
});

describe('a push that settles ops tells the open screens', () => {
  test("the app's client says the op log changed once the server takes the op", async () => {
    const opId = '01920000-0000-7000-8000-0000000000ac';
    await seedLocalOp(opId);
    const invalidation = new InvalidationBus();
    const written: string[][] = [];
    invalidation.subscribe((tables) => written.push([...tables]));
    const app = {
      db,
      engine: { applyPulledOp: () => Promise.resolve() },
      syncState: await readSyncState(db.db),
      invalidation,
    } as unknown as Bootstrapped;
    const reply = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    const client = createSyncClientForApp(app, {
      baseUrl: 'https://example.invalid',
      deviceId: DEVICE_ID,
      loadDeviceToken: () => Promise.resolve('bdt_test'),
      crypto: noblePort,
      clock: clockT,
      appState: activeAppState,
      netInfo: fakeNetInfo(true).port,
      timer: new RecordingTimer(),
      fetchImpl: (input) => {
        const url = String(input);
        if (url.endsWith('/v1/sync/push')) {
          return Promise.resolve(
            reply({ results: [{ id: opId, status: 'accepted' }], serverTime: T }),
          );
        }
        if (url.endsWith('/v1/sync/pull')) {
          return Promise.resolve(reply({ ops: [], nextCursor: 0, hasMore: false, serverTime: T }));
        }
        return Promise.resolve(new Response(null, { status: 304 }));
      },
    });
    await client.start();
    await client.settle();

    expect(written).toContainEqual([OP_SYNC_STATUS_TABLE]);
    client.stop();
  });
});

describe('work waiting for the next online contact', () => {
  test("the app's client runs onBundleChecked on a steady 304 cycle, not only on a changed bundle", async () => {
    const app = {
      db,
      engine: { applyPulledOp: () => Promise.resolve() },
      syncState: await readSyncState(db.db),
      invalidation: new InvalidationBus(),
    } as unknown as Bootstrapped;
    const reply = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    const calls: string[] = [];
    const client = createSyncClientForApp(app, {
      baseUrl: 'https://example.invalid',
      deviceId: DEVICE_ID,
      loadDeviceToken: () => Promise.resolve('bdt_test'),
      crypto: noblePort,
      clock: clockT,
      appState: activeAppState,
      netInfo: fakeNetInfo(true).port,
      timer: new RecordingTimer(),
      // The queued PIN verifier drain hangs on this: an offline PIN change leaves the bundle as it
      // was, so the next answer is a 304 and a refresh-only hook would never send the verifier.
      onBundleRefreshed: () => {
        calls.push('refreshed');
      },
      onBundleChecked: () => {
        calls.push('checked');
      },
      fetchImpl: (input) => {
        if (String(input).endsWith('/v1/sync/pull')) {
          return Promise.resolve(reply({ ops: [], nextCursor: 0, hasMore: false, serverTime: T }));
        }
        return Promise.resolve(new Response(null, { status: 304 }));
      },
    });
    await client.start();
    await client.settle();

    expect(calls).toEqual(['checked']);
    client.stop();
  });
});

describe('a new device reports first-sync progress per committed batch', () => {
  test('progress climbs through the history, then clears once the first sync completes', async () => {
    const { client, transport } = await build({ online: true });
    transport.pullPages.push(...historyPages());
    const seen: Array<number | null> = [];
    client.subscribe(() => {
      const progress = client.firstSync();
      seen.push(progress === null ? null : progress.reachedAt);
    });

    await client.start();
    await client.settle();

    const DAY = 86_400_000;
    // Page one reached day 1 of 4, page two day 3; both were reported before the cycle finished.
    expect(seen).toContain(T - 3 * DAY);
    expect(seen).toContain(T - 1 * DAY);
    expect(client.syncState().lastSuccessfulSyncAt).toBe(T);
    expect(client.firstSync()).toBeNull();
    client.stop();
  });

  test('a first sync cut short keeps its progress for the next attempt', async () => {
    const { client, transport } = await build({ online: true, bundleThrows: true });
    transport.pullPages.push(...historyPages());

    await client.start();
    await client.settle();

    const DAY = 86_400_000;
    expect(client.syncState().lastSuccessfulSyncAt).toBeNull();
    expect(client.firstSync()).toStrictEqual({
      historyStart: T - 4 * DAY,
      reachedAt: T - 1 * DAY,
      serverTime: T,
    });
    client.stop();
  });

  test('a device that has synced before shows no first-sync progress', async () => {
    const { client, transport } = await build({ online: true });
    await client.start();
    await client.settle();
    expect(client.syncState().lastSuccessfulSyncAt).toBe(T);

    transport.pullPages.push(...historyPages());
    client.requestManual();
    await client.settle();
    expect(client.firstSync()).toBeNull();
    client.stop();
  });
});

describe('trigger (d): the OS background task drives the started client', () => {
  test('start registers the sync task, and a pass runs a real background cycle', async () => {
    const platform = fakeBackgroundPlatform({});
    const host = createBackgroundHost({ timer: new FakeTimer() });
    const { client, transport } = await build({ online: false, background: { platform, host } });
    await client.start();
    expect(client.backgroundRegistration()).toEqual({ kind: 'registered' });
    expect(platform.registered.map((entry) => entry.name)).toEqual([SYNC_BACKGROUND_TASK]);
    expect(transport.pulls).toHaveLength(0); // booted offline: no foreground trigger has run

    await platform.executors.get(SYNC_BACKGROUND_TASK)?.();
    expect(transport.pulls.length).toBeGreaterThan(0);
    expect((await readSyncState(db.db)).lastSuccessfulSyncAt).toBe(T);
    client.stop();
  });

  test('a stopped client is no longer driven by a background pass', async () => {
    const platform = fakeBackgroundPlatform({});
    const timer = new FakeTimer();
    const host = createBackgroundHost({ timer });
    const { client, transport } = await build({ online: false, background: { platform, host } });
    await client.start();
    client.stop();

    await host.runPass(); // no client, and this host has no headless boot
    expect(transport.pulls).toHaveLength(0);
  });

  test('a headless pass syncs without starting triggers, then passes drive the opened app', async () => {
    // A killed app woken by the OS: the host builds a client for the pass, hydrated but with no
    // triggers of its own. The user opening the app mid-pass must not start a second loop.
    const timer = new FakeTimer();
    const headless = await build({ online: true });
    let headlessStopped = false;
    const host = createBackgroundHost({
      timer,
      startHeadless: async () => {
        await headless.client.startForBackgroundPass();
        return {
          target: headless.client,
          stop: () => {
            headlessStopped = true;
            headless.client.stop();
          },
        };
      },
    });
    await host.runPass();
    expect(headless.transport.pulls.length).toBeGreaterThan(0);
    expect(headless.net.subscriptions()).toBe(0); // no trigger or UI subscription was opened
    expect(headlessStopped).toBe(true);
    expect((await readSyncState(db.db)).lastSuccessfulSyncAt).toBe(T);

    const platform = fakeBackgroundPlatform({});
    const fg = await build({ online: false, background: { platform, host } });
    await fg.client.start();
    expect(fg.client.backgroundRegistration()).toEqual({ kind: 'registered' });
    const before = fg.transport.pulls.length;
    await platform.executors.get(SYNC_BACKGROUND_TASK)?.();
    expect(fg.transport.pulls.length).toBeGreaterThan(before); // passes now drive the open app
    fg.client.stop();
  });

  test('a client stopped while waiting for its claim gives the host straight back', async () => {
    const timer = new FakeTimer();
    const host = createBackgroundHost({ timer });
    const platform = fakeBackgroundPlatform({});
    const { client } = await build({ online: false, background: { platform, host } });
    const starting = client.start();
    client.stop();
    await starting;
    expect(platform.registered).toHaveLength(0);

    // The host is free: a later client claims and is driven without waiting out a stale lease.
    const next = await build({ online: false, background: { platform, host } });
    await next.client.start();
    expect(next.client.backgroundRegistration()).toEqual({ kind: 'registered' });
    next.client.stop();
  });

  test('a restricted platform is reported, not mistaken for a registration', async () => {
    const platform = fakeBackgroundPlatform({ status: 1 });
    const host = createBackgroundHost({ timer: new FakeTimer() });
    const { client } = await build({ online: false, background: { platform, host } });
    await client.start();
    expect(client.backgroundRegistration()).toEqual({ kind: 'restricted' });
    expect(platform.registered).toHaveLength(0);
    client.stop();
  });
});

describe('knowsOp: can this build fold a pulled op?', () => {
  const operations = {
    schemaVersionFor: (type: string) => (type === 'repair.ticket_opened' ? 4 : undefined),
  };

  test('folds any version up to the one it declares', () => {
    expect(knowsOp(operations, { type: 'repair.ticket_opened', schemaVersion: 1 })).toBe(true);
    expect(knowsOp(operations, { type: 'repair.ticket_opened', schemaVersion: 4 })).toBe(true);
  });

  test('a newer version or an unknown type comes from a newer app', () => {
    expect(knowsOp(operations, { type: 'repair.ticket_opened', schemaVersion: 5 })).toBe(false);
    expect(knowsOp(operations, { type: 'stock.item_received', schemaVersion: 1 })).toBe(false);
  });
});
