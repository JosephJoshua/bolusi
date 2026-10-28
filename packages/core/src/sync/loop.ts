// The client sync loop (api/01-sync §6; machine 03-state-machines §10).
//
//   push all syncStatus=local ops in seq order (batched)   // skipped while SyncState.pushHalted
//   pull until hasMore=false                                // applies devices sidecar when present
//   conditional GET /v1/devices/me/bundle                   // at most every 50 s; 304 steady-state
//   set lastSuccessfulSyncAt / lastServerTime; recompute derived pending counts
//
// THE LOOP NEVER THROWS TO ITS CALLER (api/01 §6). Not on a network error, not on a rejected op, not
// on a revoked device, not on a UI sink that throws. `requestSync` is `void` and every failure path
// speaks through `SyncState`, which drives the staleness indicators (03 §8). This is not defensive
// habit: step 7 of the append path (04 §5.1) fires `SyncSchedulerPort.schedule()` after a command has
// ALREADY committed locally, and a locally durable op is a successful command. If the scheduler could
// throw, an offline device would fail commands for the crime of being offline — the exact opposite of
// the product (FR-1107/FR-1125).
//
// SINGLE-FLIGHT IS CLAIMED SYNCHRONOUSLY, and that is the whole trick. `requestSync` checks the loop
// state and transitions `idle → pushing` with NO `await` between the two. JS concurrency is
// interleaving at await points, so a check that awaited anything before claiming the slot (a
// `syncDisabled` read, say) would let N triggers all pass the check and start N cycles — the classic
// check-then-act hole, and it would not be a rare race but the NORMAL outcome of the periodic timer
// firing while a NetInfo event lands. Hence `syncDisabled`/`pushHalted` are hydrated into memory:
// the guard has to be answerable without yielding. `hydrate()` is therefore mandatory before the
// first trigger, and the loop says so rather than quietly assuming `false`.
import type { CryptoPort } from '../crypto/port.js';
import type { ClockPort } from '../runtime/ports.js';
import { runTransition } from '../state-machines/executor.js';
import type { SignedOperation } from '@bolusi/schemas';
import type { Kysely } from 'kysely';

import { syncBackoffDelayMs } from './backoff.js';
import { SYNC_LOOP_MACHINE, type SyncLoopEvent, type SyncLoopState } from './loop-machine.js';
import {
  DEVICE_REVOKED_ERROR_CODE,
  SyncTransportError,
  TOKEN_INVALID_ERROR_CODE,
  type BundleRefreshPort,
  type CancelTimer,
  type SyncSurfacePort,
  type SyncTransportPort,
  type TimerPort,
} from './ports.js';
import { runPullPhase, type PulledBatch } from './pull.js';
import { runPushPhase, type PushSettled } from './push.js';
import {
  pendingMediaCount,
  pendingOperationCount,
  readSyncState,
  writeSyncState,
} from './state.js';

/** The api/01-sync §5 trigger set. Platform wiring (NetInfo, debounce, interval, …) is task 24. */
export type SyncTriggerReason =
  /** (a) connectivity regained — NetInfo listener. */
  | 'connectivity'
  /** (b) debounced 3 s after any local append. */
  | 'append'
  /** (c) periodic every 60 s while online and foregrounded. */
  | 'periodic'
  /** (d) background task, best-effort — OS-controlled cadence, a bonus not a guarantee. */
  | 'background'
  /** (e) manual pull-to-refresh. */
  | 'manual';

/**
 * The two reasons that CANCEL a running backoff timer (03 §10: "manual trigger **or** connectivity
 * regained"). Everything else is absorbed — it neither shortens nor resets the timer.
 *
 * The asymmetry is the point. A 60 s periodic tick firing inside a 5-minute backoff must not drag
 * the retry forward every minute — that would silently flatten the whole schedule to its shortest
 * interval and hammer a server that is already failing. But a human pressing refresh, or the network
 * genuinely coming back, are NEW INFORMATION: the reason for the wait may be gone. Absorbing those
 * would make the app feel broken.
 */
const EARLY_EXIT_REASONS: ReadonlySet<SyncTriggerReason> = new Set<SyncTriggerReason>([
  'manual',
  'connectivity',
]);

/**
 * The least time between two bundle refreshes, unless a person asked for a sync (pull-to-refresh).
 * The bundle (staff, roles, PIN verifiers) changes rarely, but a store device runs a cycle for every
 * live-update poke and every change it makes, so refreshing once per cycle sent a busy phone past the
 * server's 120-per-hour bundle limit (api/02-auth §9) and into backoff for up to an hour. Every 50 s
 * keeps a device under 72 an hour while a role or PIN change still lands within a minute.
 */
export const BUNDLE_REFRESH_INTERVAL_MS = 50_000;

/**
 * When a server that keeps refusing this device's token counts as "no longer knows this phone".
 * Device tokens never expire, so a lasting `AUTH_TOKEN_INVALID` means the server lost the device
 * (reset, restore, row removed, wrong server). Both limits must be met: three refusals in a row so
 * one odd answer never trips it, and ten minutes so a deploy or a brief server fault rides through.
 * Only a successful sync breaks the streak; a network failure in between proves nothing either way.
 */
export const DEVICE_UNRECOGNISED_AFTER = { refusals: 3, ms: 10 * 60_000 } as const;

/** `syncDisabledReason` for a device the server no longer recognises. */
export const DEVICE_UNRECOGNISED_REASON = 'device_unrecognised';

export interface SyncLoopOptions<DB> {
  readonly db: Kysely<DB>;
  readonly transaction: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly transport: SyncTransportPort;
  readonly bundle: BundleRefreshPort;
  readonly surface: SyncSurfacePort;
  readonly crypto: CryptoPort;
  readonly clock: ClockPort;
  readonly timer: TimerPort;
  readonly deviceId: string;
  readonly applyPulledOp: (op: SignedOperation) => Promise<unknown>;
  /** `ProjectionEngine.refoldRefused`: the push phase takes a refused op back out of its record. */
  readonly refoldRefused: (op: SignedOperation) => Promise<unknown>;
  readonly pushBatchSize?: number;
  readonly pullLimit?: number;
  /** Passed to the pull phase: called after each committed batch (progress display only). */
  readonly onPullBatch?: (batch: PulledBatch) => void;
  /**
   * Called after each pushed batch that changed ops' sync status (any taken or refused), even when
   * a later batch of the same push then fails.
   */
  readonly onPushed?: (settled: PushSettled) => void;
}

/** Observable cycle counters — for tests and diagnostics; not persisted, not a contract with the UI. */
export interface SyncCycleStats {
  readonly cycles: number;
  readonly pushed: number;
  readonly pulled: number;
  readonly quarantined: number;
  readonly bundleRefreshes: number;
}

export class SyncLoop<DB> {
  private loopState: SyncLoopState = 'idle';
  /** In-memory (03 §10: "`failureCount` is in-memory"). A restart retries at once — deliberate. */
  private failureCount = 0;
  private rerun = false;
  private cancelBackoff: CancelTimer | null = null;
  private cycle: Promise<void> = Promise.resolve();
  private hydrated = false;
  /** Set by `pause()`: the running cycle stops at its next batch boundary and no rerun follows. */
  private pauseRequested = false;
  /** Set by `stop()`: this loop never starts another cycle. */
  private stopped = false;
  /** Mirrors of the persisted guards, so the trigger guard needs no `await` (see the header). */
  private syncDisabled = false;
  private pushHalted = false;
  /** Mirrors of the persisted token-refusal streak (see DEVICE_UNRECOGNISED_AFTER). */
  private tokenRejectedSince: number | null = null;
  private tokenRejectedCount = 0;
  /** Clock time of the last successful bundle refresh; null until the first (in-memory on purpose). */
  private bundleRefreshedAt: number | null = null;
  /** A manual trigger asked for a fresh bundle, possibly while a cycle was running. */
  private bundleWanted = false;
  private stats: SyncCycleStats = {
    cycles: 0,
    pushed: 0,
    pulled: 0,
    quarantined: 0,
    bundleRefreshes: 0,
  };

  constructor(private readonly options: SyncLoopOptions<DB>) {}

  /** Load the persisted guards. MUST run before the first trigger (see the header). */
  async hydrate(): Promise<void> {
    const state = await readSyncState(this.options.db);
    this.syncDisabled = state.syncDisabled;
    this.pushHalted = state.pushHalted;
    this.tokenRejectedSince = state.tokenRejectedSince;
    this.tokenRejectedCount = state.tokenRejectedCount;
    this.hydrated = true;
  }

  get state(): SyncLoopState {
    return this.loopState;
  }

  getStats(): SyncCycleStats {
    return this.stats;
  }

  /**
   * The single entry point for every api/01 §5 trigger (03 §10). Fire-and-forget by contract.
   *
   * @throws {Error} only if `hydrate()` was never awaited — a programming error, surfaced loudly
   * rather than defaulting `syncDisabled` to `false`, which would let a revoked device sync.
   */
  requestSync(reason: SyncTriggerReason): void {
    if (!this.hydrated) {
      throw new Error('SyncLoop.hydrate() must be awaited before requestSync()');
    }
    // 03 §10 trigger guard: `syncDisabled` ⇒ no cycle starts, for ANY reason including manual.
    if (this.syncDisabled || this.stopped) return;
    // Realtime pokes arrive as `connectivity` too (apps/mobile sync-client), so only a person's
    // explicit refresh skips the bundle interval.
    if (reason === 'manual') this.bundleWanted = true;

    if (this.loopState === 'pushing' || this.loopState === 'pulling') {
      // 03 §10: "any trigger arrives → (no transition), rerun flag set". Coalescing: N triggers
      // during one cycle produce ONE follow-up, because a flag is not a counter.
      this.rerun = true;
      return;
    }

    if (this.loopState === 'backoff') {
      if (!EARLY_EXIT_REASONS.has(reason)) return; // absorbed; timer untouched
      this.clearBackoffTimer();
    }

    // Claim the slot with NO await in between (see the header).
    this.pauseRequested = false;
    this.transition('trigger');
    this.cycle = this.runCycle();
  }

  /**
   * Stop the running cycle at its next push or committed pull batch, without counting it as a sync.
   * A pause during push ends the push there and lets at most one pull batch through. For a
   * time-limited background run, or handing the database to another owner. The next trigger clears
   * the pause and resumes from the committed cursor. A no-op when nothing is running.
   */
  pause(): void {
    if (this.loopState === 'pushing' || this.loopState === 'pulling') this.pauseRequested = true;
  }

  /**
   * Retire this loop: the running cycle stops as `pause()` would, no rerun or backoff retry
   * follows, and every later trigger is ignored. For an owner that is going away, so a loop left
   * in backoff cannot keep syncing behind the next owner's back.
   */
  stop(): void {
    this.stopped = true;
    this.pause();
    this.rerun = false;
    this.clearBackoffTimer();
  }

  /** Resolves when the current cycle (and any rerun it chains) has settled. Tests only. */
  async settle(): Promise<void> {
    let previous: Promise<void>;
    do {
      previous = this.cycle;
      await previous.catch(() => undefined);
    } while (this.cycle !== previous);
  }

  private transition(event: SyncLoopEvent): void {
    // Through the shared executor (03 §1): an invalid pair throws INVALID_TRANSITION rather than
    // silently landing in a state this table never allowed.
    this.loopState = runTransition(SYNC_LOOP_MACHINE, this.loopState, event).to;
  }

  private clearBackoffTimer(): void {
    this.cancelBackoff?.();
    this.cancelBackoff = null;
  }

  private async runCycle(): Promise<void> {
    this.rerun = false;
    this.stats = { ...this.stats, cycles: this.stats.cycles + 1 };

    try {
      // ── push ────────────────────────────────────────────────────────────────────────────
      // 03 §10: `pushHalted` ⇒ the push phase is SKIPPED and we proceed straight to pulling.
      // Pull must keep draining — a device with a broken chain still needs the rest of the
      // tenant's history, and halting both would turn a push-side fault into total blindness.
      if (!this.pushHalted) {
        const push = await runPushPhase({
          db: this.options.db,
          transport: this.options.transport,
          surface: this.options.surface,
          clock: this.options.clock,
          deviceId: this.options.deviceId,
          shouldContinue: () => !this.pauseRequested,
          onBatchSettled: (settled) => this.notifyPushed(settled),
          transaction: this.options.transaction,
          refoldRefused: this.options.refoldRefused,
          onChainBroken: async () => {
            this.pushHalted = true;
            await writeSyncState(this.options.db, { pushHalted: true });
          },
          ...(this.options.pushBatchSize === undefined
            ? {}
            : { batchSize: this.options.pushBatchSize }),
        });
        this.stats = { ...this.stats, pushed: this.stats.pushed + push.synced };
        await writeSyncState(this.options.db, { lastPushAt: this.options.clock.now() });
      }
      this.transition('push_drained');

      // ── pull ────────────────────────────────────────────────────────────────────────────
      const pull = await runPullPhase({
        db: this.options.db,
        transaction: this.options.transaction,
        transport: this.options.transport,
        surface: this.options.surface,
        crypto: this.options.crypto,
        clock: this.options.clock,
        applyPulledOp: this.options.applyPulledOp,
        ...(this.options.pullLimit === undefined ? {} : { limit: this.options.pullLimit }),
        ...(this.options.onPullBatch === undefined
          ? {}
          : { onBatchCommitted: this.options.onPullBatch }),
        shouldContinue: () => !this.pauseRequested,
      });
      this.stats = {
        ...this.stats,
        pulled: this.stats.pulled + pull.applied,
        quarantined: this.stats.quarantined + pull.quarantined,
      };
      if (!pull.drained) {
        // Paused mid-pull: what was pulled is committed, but the device is not caught up, so this
        // is not a successful sync and nothing reruns until the next trigger.
        this.transition('pull_paused');
        this.pauseRequested = false;
        return;
      }

      // ── bundle refresh (throttled) ──────────────────────────────────────────────────────
      // 304 is SUCCESS (api/02-auth §5): a steady-state device gets one on nearly every refresh, and
      // a loop that treated it as failure would live in permanent backoff.
      //
      // JUDGMENT (api/01 §6 lists this step; 03 §10's table does not mention it): a bundle failure
      // is a transport failure and enters backoff, and `lastSuccessfulSyncAt` is NOT set — the
      // machine only reaches `idle` via `pull_drained`, which we have not yet fired. The device
      // therefore looks staler than it is while the bundle endpoint is down. That is the SAFE
      // direction: a false "your data may be old" costs a banner, a false "you are current" costs
      // a wrong business decision (03 §8 exists to prevent exactly the latter).
      //
      // At most once per BUNDLE_REFRESH_INTERVAL_MS, unless a person asked for it.
      const refreshStartedAt = this.options.clock.now();
      if (
        this.bundleWanted ||
        this.bundleRefreshedAt === null ||
        refreshStartedAt - this.bundleRefreshedAt >= BUNDLE_REFRESH_INTERVAL_MS
      ) {
        await this.options.bundle.refresh();
        this.bundleWanted = false;
        this.bundleRefreshedAt = refreshStartedAt;
        this.stats = { ...this.stats, bundleRefreshes: this.stats.bundleRefreshes + 1 };
      }

      // ── drain complete (03 §10: `pulling → idle`) ───────────────────────────────────────
      this.transition('pull_drained');
      this.failureCount = 0;
      this.tokenRejectedSince = null;
      this.tokenRejectedCount = 0;
      const now = this.options.clock.now();
      await writeSyncState(this.options.db, {
        lastSuccessfulSyncAt: now,
        lastSyncError: null,
        backoffUntil: null,
        tokenRejectedSince: null,
        tokenRejectedCount: 0,
        ...(pull.serverTime === null
          ? {}
          : { lastServerTime: pull.serverTime, lastServerTimeReceivedAt: now }),
      });
      // Recompute the derived counts (03 §10 / 01 §5.2). Queried, never stored — the call exists
      // for the invalidation it drives; there is deliberately no column to write.
      await pendingOperationCount(this.options.db);
      await pendingMediaCount(this.options.db);
    } catch (error) {
      this.pauseRequested = false;
      await this.handleCycleFailure(error);
      return;
    }

    // A pause that arrived too late to stop the pull still suppresses the rerun.
    const paused = this.pauseRequested;
    this.pauseRequested = false;
    // 03 §10: "if the rerun flag is set, immediately re-enter `pushing`". ONE follow-up regardless
    // of how many triggers coalesced into it.
    if (this.rerun && !this.syncDisabled && !paused && !this.stopped) {
      this.transition('trigger');
      this.cycle = this.runCycle();
    }
  }

  private async handleCycleFailure(error: unknown): Promise<void> {
    if (isDeviceRevoked(error)) {
      // 03 §10 "any → idle on 401 DEVICE_REVOKED": all sync stops, no further automatic cycles
      // until re-enrollment. Terminal for this enrollment by design — there is no un-revoke (03 §5).
      await this.disableSync('device_revoked', DEVICE_REVOKED_ERROR_CODE, 'auth.revoked.title');
      return;
    }

    if (isTokenRejected(error)) {
      // The server does not know this token. Count it; past DEVICE_UNRECOGNISED_AFTER it stops
      // sync like a revocation, otherwise it backs off below like any other failure.
      const now = this.options.clock.now();
      this.tokenRejectedSince ??= now;
      this.tokenRejectedCount += 1;
      await writeSyncState(this.options.db, {
        tokenRejectedSince: this.tokenRejectedSince,
        tokenRejectedCount: this.tokenRejectedCount,
      });
      if (
        this.tokenRejectedCount >= DEVICE_UNRECOGNISED_AFTER.refusals &&
        now - this.tokenRejectedSince >= DEVICE_UNRECOGNISED_AFTER.ms
      ) {
        await this.disableSync(
          DEVICE_UNRECOGNISED_REASON,
          TOKEN_INVALID_ERROR_CODE,
          'auth.unrecognised.title',
        );
        return;
      }
    }

    // Transport/server failure ⇒ backoff (03 §10). Op-level rejections never reach here — they are
    // results inside a resolved response, not thrown (push.ts).
    this.transition('transport_failure');
    // A retired loop records nothing: the next owner has its own state and its own retries.
    if (this.stopped) return;
    this.failureCount += 1;
    const delay = syncBackoffDelayMs(this.failureCount);
    const until = this.options.clock.now() + delay;
    await writeSyncState(this.options.db, {
      lastSyncError: errorCode(error),
      backoffUntil: until,
    });
    this.clearBackoffTimer();
    this.cancelBackoff = this.options.timer.schedule(delay, () => {
      this.cancelBackoff = null;
      if (this.syncDisabled || this.stopped) return;
      if (this.loopState !== 'backoff') return;
      this.transition('timer_elapsed');
      this.cycle = this.runCycle();
    });
  }

  /** Stop all automatic sync until the device is enrolled again (03 §10 `syncDisabled`). */
  private async disableSync(reason: string, errorCode: string, labelKey: string): Promise<void> {
    this.transition('device_revoked');
    this.syncDisabled = true;
    this.rerun = false;
    this.clearBackoffTimer();
    await writeSyncState(this.options.db, {
      syncDisabled: true,
      syncDisabledReason: reason,
      lastSyncError: errorCode,
      backoffUntil: null,
    });
    this.emit({ kind: 'sync_disabled', reason, labelKey });
  }

  private notifyPushed(settled: PushSettled): void {
    try {
      this.options.onPushed?.(settled);
    } catch {
      // A notification only: a throwing listener must not fail the cycle that already pushed.
    }
  }

  private emit(event: Parameters<SyncSurfacePort['emit']>[0]): void {
    try {
      this.options.surface.emit(event);
    } catch {
      // api/01 §6: never throws to the UI — including when the UI is what threw.
    }
  }
}

/**
 * Is this the revoked-device signal (api/01-sync §2)?
 *
 * Discriminates on the api/00 §7 envelope's `error.code`, NOT on the 401 status: `AUTH_TOKEN_MISSING`
 * and `AUTH_TOKEN_INVALID` are also 401s (apps/server/src/errors.ts). `syncDisabled` has no automatic
 * exit (03 §10) and clearing it means re-enrolling the device, so treating an expired token as a
 * revocation would brick a working device on a recoverable error.
 */
function isDeviceRevoked(error: unknown): boolean {
  return error instanceof SyncTransportError && error.code === DEVICE_REVOKED_ERROR_CODE;
}

/**
 * Did the server refuse this device's token as unknown? Only the server's own answer counts: a
 * locally missing token (`AUTH_TOKEN_MISSING`, e.g. a keystore not readable before first unlock)
 * says nothing about whether the server still knows the device.
 */
function isTokenRejected(error: unknown): boolean {
  return (
    error instanceof SyncTransportError &&
    error.code === TOKEN_INVALID_ERROR_CODE &&
    error.status === 401
  );
}

/** The label-catalog code for `lastSyncError` (01 §5.2: "last failure, label-catalog code"). */
function errorCode(error: unknown): string {
  if (error instanceof SyncTransportError && error.code !== null) return error.code;
  return 'NETWORK';
}
