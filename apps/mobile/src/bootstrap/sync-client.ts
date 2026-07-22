// The SYNC CLIENT — the construction task 15's loop was waiting for (task 89).
//
// Task 15 shipped a correct `SyncLoop` and nothing built one; task 50 built the transport + trigger
// adapters and nothing wired them to a loop. This file is the missing constructor: it assembles the
// loop with its real deps (the one DB connection, the fetch transport, the bundle producer, the
// clock/timer/crypto ports), attaches the §5 triggers, hydrates, and starts. After this, an enrolled
// device syncs — `lastSuccessfulSyncAt` stops being `null` on the first cycle and the never-connected
// banner clears.
//
// ── WHAT THIS DELIVERS (read before assuming "a real device syncs") ──────────────────────────────
// This makes the loop RUN when given an enrolled device's persisted state (`deviceId` in `meta_kv`,
// the seeded `sync_state`, any local ops). It is proven end-to-end in `sync-client.test.ts` against a
// fake transport with fake timers and ZERO sockets. A production device now REACHES that enrolled
// state: the command-runtime composition + enrollment caller (bootstrap/runtime.ts, bootstrap/
// enrollment.ts — task 92) append the signed genesis and persist `deviceId`, and Root starts THIS
// loop on enroll success (no reboot). What remains headless-only is the on-device/on-server leg — a
// real POST, a real SQLCipher file at rest — owed to task 27a (D12/D13); the fake transport here does
// not exercise it.
//
// ── THE REACTIVE VIEW (why this owns state Root reads) ───────────────────────────────────────────
// Root must reflect two things that change over time: the loop's state (03 §10) and connectivity
// (NetInfo). Rather than have Root poll the DB, this client owns a small reactive view — `state()`,
// `isOffline()`, `syncState()` — and fires `subscribe` listeners after each cycle settles and on
// every connectivity change. `syncState()` is RE-READ from `sync_state` after each cycle, so the
// banner clears from the real column (T-19), never a `?? Date.now()`.
import {
  readSyncState,
  SyncLoop,
  type BundleRefreshPort,
  type ClockPort,
  type CryptoPort,
  type SyncLoopState,
  type SyncState,
  type SyncSchedulerPort,
  type SyncSurfacePort,
  type SyncSurfacing,
  type SyncTransportPort,
  type SyncTriggerReason,
  type TimerPort,
} from '@bolusi/core';
import type { ClientDatabase, ClientDb } from '@bolusi/db-client';
import type { SignedOperation } from '@bolusi/schemas';

import type { Bootstrapped } from './bootstrap.js';
import { createFetchBundleRefresh } from './bundle.js';
import {
  createRealtimeController,
  type RealtimeHandle,
  type RealtimeSocketCtor,
} from './realtime-client.js';
import { createFetchSyncTransport } from './transport.js';
import {
  createSyncTriggers,
  type AppStatePort,
  type NetInfoPort,
  type SyncTriggers,
} from './triggers.js';
import { systemTimer } from '../ports/timer.js';

/** Cap on the retained surfacing buffer — a device running for a week must not grow it unbounded. */
const SURFACE_BUFFER_MAX = 100;

/** The raw deps the loop + triggers need. Ports are pre-built so a test injects fakes directly. */
export interface SyncClientDeps {
  /** The one client connection (08 §2.2): `db.db` is the loop's Kysely; `db.transaction` its atom. */
  readonly db: ClientDb;
  /** The enrolled device's id (task 88 persists it to `meta_kv`; bootstrap reads it). */
  readonly deviceId: string;
  readonly transport: SyncTransportPort;
  readonly bundle: BundleRefreshPort;
  /** `ProjectionEngine.applyPulledOp` — the pull phase folds through it inside the batch txn. */
  readonly applyPulledOp: (op: SignedOperation) => Promise<unknown>;
  readonly crypto: CryptoPort;
  readonly clock: ClockPort;
  readonly timer: TimerPort;
  readonly appState: AppStatePort;
  readonly netInfo: NetInfoPort;
  /** The device's `SyncState` at boot (bootstrap already read it); kept live after each cycle. */
  readonly initialSyncState: SyncState;
  /** Optional surfacing sink; defaults to a bounded in-memory buffer exposed via `surfacings()`. */
  readonly surface?: SyncSurfacePort;
  readonly pushBatchSize?: number;
  readonly pullLimit?: number;
  /**
   * Task 105: given the loop's trigger, build the realtime controller (task 20). Its `start`/`stop`
   * RIDE the loop's — started after `hydrate()` (a trigger before hydrate throws), stopped on teardown —
   * so realtime is live for exactly an enrolled, running loop and torn down on logout/revocation. The
   * channel is ADDITIVE (FR-1146) and owns no pull cadence: it calls `trigger` on a `sync.poke` and a
   * (re)connect only. Absent in loop-only tests (no realtime), which is the honest "no channel" state.
   */
  readonly createRealtime?: (trigger: () => void) => RealtimeHandle;
}

/** The live sync client. Owns the loop + triggers and a small reactive view Root renders from. */
export interface SyncClient {
  /**
   * §5 (b), the append trigger — THE SAME OBJECT `createSyncTriggers` built, not a copy (task 136).
   *
   * Exposed because the command runtime's step-7 hook (04 §5.1) is on the other side of a
   * construction-order cycle: `AppRuntime` exists before any loop does (it appends the ENROLMENT
   * genesis, which is what produces the `deviceId` this client requires), so the runtime cannot be
   * handed a scheduler at construction. `Root` closes the cycle by binding this into the one
   * `AppRuntime` the moment the client starts — see `AppRuntime.bindSyncScheduler`.
   *
   * Until this was exposed, `createSyncTriggers(...).scheduler` had ZERO production consumers and the
   * shipping runtime bound `{ schedule: () => undefined }`, so §5 (b)'s 3 s debounce did not exist on
   * a device. Guarded end to end by `test/live-shell-sync-scheduler.test.tsx`.
   */
  readonly scheduler: SyncSchedulerPort;
  /** Hydrate the loop (mandatory before any trigger), then start the triggers (and the boot sync). */
  start(): Promise<void>;
  /** (e) pull-to-refresh. */
  requestManual(): void;
  /** Cancel every timer + subscription. Idempotent. */
  stop(): void;
  /** The live loop state (03 §10) — Root's `loopState`. */
  state(): SyncLoopState;
  /** Connectivity from NetInfo, as `isOffline` — an INPUT to the UI, never a verdict (sync-status). */
  isOffline(): boolean;
  /** The device's `SyncState`, re-read from `sync_state` after each cycle. Drives the banner (T-19). */
  syncState(): SyncState;
  /** Subscribe to loop/connectivity changes (Root re-renders). Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Surfacings captured since boot (05 §8 "never silent"); the DB stays the source of truth. */
  surfacings(): readonly SyncSurfacing[];
  /** Await the current cycle chain and re-read `sync_state`. For deterministic tests (T-6). */
  settle(): Promise<void>;
}

class SyncClientImpl implements SyncClient {
  private readonly loop: SyncLoop<ClientDatabase>;
  private readonly triggers: SyncTriggers;
  private readonly realtime: RealtimeHandle | null;
  private readonly listeners = new Set<() => void>();
  private readonly surfaceBuffer: SyncSurfacing[] = [];
  private connected = false;
  private currentSyncState: SyncState;
  private uiNetUnsub: (() => void) | null = null;

  constructor(private readonly deps: SyncClientDeps) {
    this.currentSyncState = deps.initialSyncState;

    const surface: SyncSurfacePort = deps.surface ?? {
      emit: (event) => {
        // 05 §8 "never silent": capture for diagnostics + notify. The DB stays the source of truth —
        // the sync-status screen reads rejected/quarantined/syncDisabled from their own tables — so a
        // dropped event here loses a live hint, never a fact. Bounded so it cannot grow without end.
        this.surfaceBuffer.push(event);
        if (this.surfaceBuffer.length > SURFACE_BUFFER_MAX) this.surfaceBuffer.shift();
        this.notify();
      },
    };

    this.loop = new SyncLoop<ClientDatabase>({
      db: deps.db.db,
      // The loop's atom on the SAME connection its `db` uses: ClientDb.transaction runs begin/commit
      // on the driver the Kysely dialect wraps, so the pull phase's isolation is real (pull.ts).
      transaction: (fn) => deps.db.transaction(() => fn()),
      transport: deps.transport,
      bundle: deps.bundle,
      surface,
      crypto: deps.crypto,
      clock: deps.clock,
      timer: deps.timer,
      deviceId: deps.deviceId,
      applyPulledOp: deps.applyPulledOp,
      ...(deps.pushBatchSize === undefined ? {} : { pushBatchSize: deps.pushBatchSize }),
      ...(deps.pullLimit === undefined ? {} : { pullLimit: deps.pullLimit }),
    });

    this.triggers = createSyncTriggers({
      requestSync: (reason) => this.request(reason),
      timer: deps.timer,
      appState: deps.appState,
      netInfo: deps.netInfo,
    });

    // The realtime controller (task 20), if the app wired one. Constructing it here (not started) closes
    // its ONLY edge into sync — `trigger` — over this loop; `start()` opens the socket, `stop()` tears it
    // down. Built in the constructor so the lifecycle is unconditionally coupled to this client's.
    this.realtime = deps.createRealtime?.(() => this.triggerFromRealtime()) ?? null;
  }

  /** §5 (b) — the triggers' own scheduler, handed out so `Root` can bind it into the runtime. */
  get scheduler(): SyncSchedulerPort {
    return this.triggers.scheduler;
  }

  async start(): Promise<void> {
    // hydrate() BEFORE any trigger: the loop throws if a trigger arrives un-hydrated (loop.ts), and
    // the boot connectivity trigger fires inside triggers.start() below.
    await this.loop.hydrate();
    this.currentSyncState = await readSyncState(this.deps.db.db);
    // The UI half of connectivity (isOffline). The trigger's OWN subscription is inside triggers —
    // this one only mirrors the state Root renders. NetInfo fires immediately with the current value.
    this.uiNetUnsub = this.deps.netInfo.subscribe((connected) => {
      this.connected = connected;
      this.notify();
    });
    this.triggers.start();
    // Realtime rides the loop and can only trigger AFTER hydrate() (requestSync throws un-hydrated), so
    // it is started LAST — a poke now has a hydrated loop to drive. Purely additive (FR-1146): if the
    // channel never connects, the §5 triggers above keep sync converging with no dependency on it.
    this.realtime?.start();
  }

  requestManual(): void {
    this.triggers.requestManual();
  }

  stop(): void {
    this.realtime?.stop();
    this.triggers.stop();
    this.uiNetUnsub?.();
    this.uiNetUnsub = null;
  }

  state(): SyncLoopState {
    return this.loop.state;
  }

  isOffline(): boolean {
    // Offline until NetInfo confirms otherwise — the honest default (design-system §4: never a
    // cheerful "online" a device that has not reached a network cannot back up).
    return !this.connected;
  }

  syncState(): SyncState {
    return this.currentSyncState;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  surfacings(): readonly SyncSurfacing[] {
    return this.surfaceBuffer;
  }

  async settle(): Promise<void> {
    await this.loop.settle().catch(() => undefined);
    this.currentSyncState = await readSyncState(this.deps.db.db);
    this.notify();
  }

  private request(reason: SyncTriggerReason): void {
    this.loop.requestSync(reason);
    void this.afterCycle();
  }

  /**
   * The realtime channel's ONLY edge into sync (task 20's `RealtimeControllerDeps.trigger`, wired by
   * task 105): run a cycle on a `sync.poke` or a (re)connect backfill.
   *
   * Mapped to the `'connectivity'` reason DELIBERATELY. The controller fires this on exactly the two
   * NEW-INFORMATION events that 03 §10's early-exit class exists for: a poke is the server's own
   * confirmation that (a) it is reachable and (b) there are ops in this device's pull scope, and a
   * (re)connect is "a channel just came up — backfill what was missed". Both mean "the reason for any
   * sync backoff may be gone", so the cycle should run NOW rather than wait out the 5-min timer — which
   * is the whole latency point of realtime. Of the five §5 reasons, only `manual` and `connectivity`
   * break a running backoff (EARLY_EXIT_REASONS), and `manual` means a human pressed refresh; a
   * server-driven realtime event is the automatic analogue of connectivity, so it reuses that reason.
   *
   * It stays ADDITIVE and single-flight: `requestSync` coalesces concurrent triggers into the one
   * in-flight cycle (a rerun flag, not a counter — never a parallel loop), and NOTHING here gates sync,
   * so a dead channel changes nothing (FR-1146). The reason is used ONLY for the backoff early-exit
   * decision (loop.ts) — it is not persisted, surfaced, or logged.
   */
  private triggerFromRealtime(): void {
    this.request('connectivity');
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private async afterCycle(): Promise<void> {
    // The loop never throws to its caller (loop.ts); it speaks through `SyncState`. So after it
    // settles — success OR backoff — re-read `sync_state` and notify, and the banner reflects the
    // real column: `lastSuccessfulSyncAt` from a durable write, never a default (T-19).
    await this.loop.settle().catch(() => undefined);
    this.currentSyncState = await readSyncState(this.deps.db.db).catch(() => this.currentSyncState);
    this.notify();
  }
}

export function createSyncClient(deps: SyncClientDeps): SyncClient {
  return new SyncClientImpl(deps);
}

/** What the composition root supplies to build the real ports (fetch transport, bundle) over a boot. */
export interface SyncClientForAppConfig {
  /** 08 §6.1's `EXPO_PUBLIC_API_URL`, no trailing slash. */
  readonly baseUrl: string;
  /** The enrolled device's id (bootstrap read it from `meta_kv`). */
  readonly deviceId: string;
  /** The SecureStore keystore — read the device token at call time, never cached (api/02-auth §7.3). */
  readonly loadDeviceToken: () => Promise<string | null>;
  readonly crypto: CryptoPort;
  readonly clock: ClockPort;
  readonly appState: AppStatePort;
  readonly netInfo: NetInfoPort;
  /** Defaults to `systemTimer`. Tests inject a FakeTimer bound to a FakeClock (T-6). */
  readonly timer?: TimerPort;
  /** Injected for tests; defaults to the global `fetch` (used by the sync legs AND the SSE reader). */
  readonly fetchImpl?: typeof fetch;
  /** Injected for the composed realtime test; defaults to the RN/global `WebSocket` (task 105). */
  readonly webSocketImpl?: RealtimeSocketCtor;
  /**
   * Invoked AFTER a `'refreshed'` bundle commit so the permission evaluator can invalidate its memo
   * (02-permissions §6 (a): "a bundle refresh wrote a directory table"). Supplied by the composition
   * root once a runtime — hence an evaluator — is composed (the enrollment/runtime task); until then
   * the bundle producer's seam stays `undefined` by design.
   */
  readonly onBundleRefreshed?: () => void | Promise<void>;
}

/**
 * Build the real sync client over a booted app. This is the platform-facing assembly: the fetch
 * transport (api/01-sync §3/§4) and the bundle producer (api/02-auth §5.2) are built here from the
 * one connection + the token reader; the loop's projection seam is the boot's own engine.
 */
export function createSyncClientForApp(
  app: Bootstrapped,
  config: SyncClientForAppConfig,
): SyncClient {
  const transport = createFetchSyncTransport({
    baseUrl: config.baseUrl,
    deviceToken: config.loadDeviceToken,
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
  });
  const bundle = createFetchBundleRefresh({
    baseUrl: config.baseUrl,
    deviceToken: config.loadDeviceToken,
    db: app.db,
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
    ...(config.onBundleRefreshed === undefined
      ? {}
      : { onBundleRefreshed: config.onBundleRefreshed }),
  });
  return createSyncClient({
    db: app.db,
    deviceId: config.deviceId,
    transport,
    bundle,
    applyPulledOp: (op) => app.engine.applyPulledOp(op),
    crypto: config.crypto,
    clock: config.clock,
    timer: config.timer ?? systemTimer,
    appState: config.appState,
    netInfo: config.netInfo,
    initialSyncState: app.syncState,
    // Task 105: the REAL realtime controller (task 20), wired here so an enrolled device's loop gets
    // pokes. The bearer travels AT CONNECT in a header (SEC-RT-01) and the token is read PER CONNECT
    // from the same SecureStore reader the sync legs use — never cached. `WebSocket`/`fetch` default to
    // the RN/Node globals (no native-binding-site injection needed), and are injectable only for tests.
    createRealtime: (trigger) =>
      createRealtimeController({
        baseUrl: config.baseUrl,
        loadDeviceToken: config.loadDeviceToken,
        trigger,
        clock: config.clock,
        timer: config.timer ?? systemTimer,
        ...(config.webSocketImpl === undefined ? {} : { webSocketImpl: config.webSocketImpl }),
        ...(config.fetchImpl === undefined ? {} : { sseFetchImpl: config.fetchImpl }),
      }),
  });
}
