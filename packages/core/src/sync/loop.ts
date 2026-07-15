// The client sync loop (api/01-sync §6; machine 03-state-machines §10).
//
//   push all syncStatus=local ops in seq order (batched)   // skipped while SyncState.pushHalted
//   pull until hasMore=false                                // applies devices sidecar when present
//   conditional GET /v1/devices/me/bundle                   // once per loop; 304 steady-state
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
  type BundleRefreshPort,
  type CancelTimer,
  type SyncSurfacePort,
  type SyncTransportPort,
  type TimerPort,
} from './ports.js';
import { runPullPhase } from './pull.js';
import { runPushPhase } from './push.js';
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
  readonly pushBatchSize?: number;
  readonly pullLimit?: number;
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
  /** Mirrors of the persisted guards, so the trigger guard needs no `await` (see the header). */
  private syncDisabled = false;
  private pushHalted = false;
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
    if (this.syncDisabled) return;

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
    this.transition('trigger');
    this.cycle = this.runCycle();
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
      });
      this.stats = {
        ...this.stats,
        pulled: this.stats.pulled + pull.applied,
        quarantined: this.stats.quarantined + pull.quarantined,
      };

      // ── bundle refresh (once per loop) ──────────────────────────────────────────────────
      // 304 is SUCCESS (api/02-auth §5): a steady-state device gets one every single cycle, and a
      // loop that treated it as failure would live in permanent backoff.
      //
      // JUDGMENT (api/01 §6 lists this step; 03 §10's table does not mention it): a bundle failure
      // is a transport failure and enters backoff, and `lastSuccessfulSyncAt` is NOT set — the
      // machine only reaches `idle` via `pull_drained`, which we have not yet fired. The device
      // therefore looks staler than it is while the bundle endpoint is down. That is the SAFE
      // direction: a false "your data may be old" costs a banner, a false "you are current" costs
      // a wrong business decision (03 §8 exists to prevent exactly the latter).
      await this.options.bundle.refresh();
      this.stats = { ...this.stats, bundleRefreshes: this.stats.bundleRefreshes + 1 };

      // ── drain complete (03 §10: `pulling → idle`) ───────────────────────────────────────
      this.transition('pull_drained');
      this.failureCount = 0;
      const now = this.options.clock.now();
      await writeSyncState(this.options.db, {
        lastSuccessfulSyncAt: now,
        lastSyncError: null,
        backoffUntil: null,
        ...(pull.serverTime === null
          ? {}
          : { lastServerTime: pull.serverTime, lastServerTimeReceivedAt: now }),
      });
      // Recompute the derived counts (03 §10 / 01 §5.2). Queried, never stored — the call exists
      // for the invalidation it drives; there is deliberately no column to write.
      await pendingOperationCount(this.options.db);
      await pendingMediaCount(this.options.db);
    } catch (error) {
      await this.handleCycleFailure(error);
      return;
    }

    // 03 §10: "if the rerun flag is set, immediately re-enter `pushing`". ONE follow-up regardless
    // of how many triggers coalesced into it.
    if (this.rerun && !this.syncDisabled) {
      this.transition('trigger');
      this.cycle = this.runCycle();
    }
  }

  private async handleCycleFailure(error: unknown): Promise<void> {
    if (isDeviceRevoked(error)) {
      // 03 §10 "any → idle on 401 DEVICE_REVOKED": all sync stops, no further automatic cycles
      // until re-enrollment. Terminal for this enrollment by design — there is no un-revoke (03 §5).
      this.transition('device_revoked');
      this.syncDisabled = true;
      this.rerun = false;
      this.clearBackoffTimer();
      await writeSyncState(this.options.db, {
        syncDisabled: true,
        syncDisabledReason: 'device_revoked',
        lastSyncError: DEVICE_REVOKED_ERROR_CODE,
      });
      this.emit({
        kind: 'sync_disabled',
        reason: 'device_revoked',
        labelKey: 'auth.revoked.title',
      });
      return;
    }

    // Transport/server failure ⇒ backoff (03 §10). Op-level rejections never reach here — they are
    // results inside a resolved response, not thrown (push.ts).
    this.transition('transport_failure');
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
      if (this.syncDisabled) return;
      if (this.loopState !== 'backoff') return;
      this.transition('timer_elapsed');
      this.cycle = this.runCycle();
    });
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

/** The label-catalog code for `lastSyncError` (01 §5.2: "last failure, label-catalog code"). */
function errorCode(error: unknown): string {
  if (error instanceof SyncTransportError && error.code !== null) return error.code;
  return 'NETWORK';
}
