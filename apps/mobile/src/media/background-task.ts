// Trigger (d) — `expo-background-task` — 06-media-pipeline §5.2(d) / §5.4.
//
// ── THE TRAP THIS FILE EXISTS TO CLOSE ──────────────────────────────────────────────────────────
// `BackgroundTask.registerTaskAsync` RESOLVES SUCCESSFULLY HAVING REGISTERED NOTHING when the
// platform reports `BackgroundTaskStatus.Restricted`. That is not a hypothesis from a doc page — it
// is read out of the installed 57.0.2 source, `build/BackgroundTask.js`:
//
//     if ((await ExpoBackgroundTaskModule.getStatusAsync()) === BackgroundTaskStatus.Restricted) {
//       ...console.warn(...); return;      // <- resolves. no registration. no throw.
//     }
//
// It is `setNotificationChannelAsync`'s exact shape (task 59, §2.11: a call that succeeds at doing
// nothing) and it fires on real hardware, not just in tests: iOS SIMULATORS are always `Restricted`
// (the warning branch says so), Expo Go is always `Restricted` (`getStatusAsync` hard-codes it), and
// Android returns it whenever the user or an OEM battery manager has restricted background work —
// which on the aggressive skins 08 §2.2 calls out is a normal, shipped configuration.
//
// So `register()` below does three things a bare call does not:
//   1. reads `getStatusAsync()` FIRST and reports `Restricted` as its own outcome, before calling;
//   2. calls `isTaskRegisteredAsync` AFTER and returns `not_registered` if the registration did not
//      take — the guard asserts its OWN coverage rather than trusting the call it just made;
//   3. returns a discriminated outcome instead of `void`, so the caller CANNOT accidentally treat
//      "restricted" as success. There is no `?? true` available to it and no silent path.
// The point is not the retry. It is that nobody may be told uploads are queued in the background
// when they are not: 06 §5.4 is explicit that this trigger "is a bonus, never a guarantee", and the
// foreground loop (§5.1, the primary driver) is unaffected by every outcome below.
//
// ── WHAT §5.4 ASKS FOR AND WHAT THIS DELIVERS (stated, not glossed) ─────────────────────────────
// §5.4: "runs one bounded drain pass: **at most one media item or 60 s, whichever first**, then
// yields." The 60 s bound is REAL here — the pass races the loop's settle against a timer and
// yields when it expires. The ONE-ITEM bound IS NOT ENFORCED, and cannot be from this side:
// `MediaDrainLoop` (packages/core/src/media/drain.ts) exposes `requestDrain` / `settle` and no
// per-item bound, and task 82 may not edit the engine (task 18 owns it). A bounded pass that
// uploads two small items inside 60 s therefore overshoots the item bound while honouring the time
// bound. Recorded as a real gap rather than implied away: closing it is a small addition to core's
// loop (`requestDrain(reason, { maxItems })`) and belongs to whoever owns 06 next.
import type { MediaDrainTrigger } from '@bolusi/core';
import type { TimerPort } from '@bolusi/core';

/** 06 §5.4's yield bound. The item bound is not enforceable here — see the header. */
export const BACKGROUND_PASS_BUDGET_MS = 60_000;

/**
 * WorkManager's floor is 15 minutes and the interval is inexact (08 §2.2, research-verified), so
 * asking for less would be a number the OS ignores. 15 is the honest minimum, not an aspiration.
 */
export const BACKGROUND_MINIMUM_INTERVAL_MINUTES = 15;

/** The process-global task name. One string, one definition — a second would define a second task. */
export const MEDIA_DRAIN_TASK = 'bolusi.media.drain';

/** `BackgroundTaskStatus` (expo-background-task): `Restricted = 1`, `Available = 2`. */
export const BACKGROUND_STATUS_RESTRICTED = 1;

/**
 * The `expo-background-task` + `expo-task-manager` surface, as a port.
 *
 * A port and not a direct import because `TaskManager.defineTask` is a PROCESS-GLOBAL side effect
 * that must run at module scope on a device, and a module-scope native call is exactly what makes a
 * file untestable under Node. Injecting it means the registration LOGIC — the part that has a bug
 * worth catching — runs in the test lane, while the native binding stays a five-line adapter at the
 * composition root.
 */
export interface BackgroundTaskPlatform {
  /** `TaskManager.defineTask`. Must be called before `registerTaskAsync` — the SDK throws otherwise. */
  defineTask(name: string, executor: () => Promise<void>): void;
  /** `BackgroundTask.getStatusAsync` — `1` Restricted, `2` Available. */
  getStatusAsync(): Promise<number>;
  registerTaskAsync(name: string, options: { minimumInterval: number }): Promise<void>;
  /** `TaskManager.isTaskRegisteredAsync` — the ATTRIBUTION check (see the header, point 2). */
  isTaskRegisteredAsync(name: string): Promise<boolean>;
}

/**
 * Why the caller cannot mistake a non-registration for success.
 *
 * `restricted` and `not_registered` are DIFFERENT outcomes on purpose: the first means the platform
 * told us up front, the second means it did not and the registration still failed to take. Only the
 * second is a surprise worth investigating, and collapsing them would hide it.
 */
export type BackgroundRegistration =
  | { readonly kind: 'registered' }
  | { readonly kind: 'restricted' }
  | { readonly kind: 'not_registered' }
  | { readonly kind: 'failed'; readonly error: unknown };

export interface BackgroundDrainDeps {
  readonly platform: BackgroundTaskPlatform;
  readonly requestDrain: (reason: MediaDrainTrigger) => void;
  /** Resolves when the drain cycle (and any coalesced re-run) settles — `MediaDrainLoop.settle`. */
  readonly settle: () => Promise<void>;
  readonly timer: TimerPort;
}

/**
 * One bounded background pass: trigger a drain, wait for it, yield at the budget.
 *
 * `Promise.race` against a TIMER PORT rather than a `setTimeout`: the timer is the app's one wait
 * seam (03 §10) so this runs under fake timers with no sleeping (T-6). The loser's timer is
 * cancelled either way — a leaked 60 s timer per background wake is a battery bug on a device that
 * wakes every 15 minutes.
 *
 * Expiring is NOT a failure and nothing is rolled back: the drain loop is chunk-resumable by
 * construction (06 §5.1 — the server's `receivedChunks` is ground truth), so a pass cut short at
 * 60 s resumes exactly where it stopped on the next trigger, foreground or background.
 */
export async function runBoundedDrainPass(deps: BackgroundDrainDeps): Promise<void> {
  deps.requestDrain('background_task');
  // A holder object rather than a bare `let`: tsc's control-flow analysis cannot see that the
  // Promise executor runs synchronously, so a `let cancel` assigned inside it narrows to `never`
  // afterwards and `cancel?.()` fails to compile. The indirection is a compiler fact, not a design.
  const timer: { cancel: (() => void) | null } = { cancel: null };
  const budget = new Promise<void>((resolve) => {
    timer.cancel = deps.timer.schedule(BACKGROUND_PASS_BUDGET_MS, resolve);
  });
  try {
    await Promise.race([deps.settle(), budget]);
  } finally {
    timer.cancel?.();
  }
}

/**
 * Define + register the background task, and REPORT whether it actually took.
 *
 * `defineTask` runs unconditionally and first: the SDK throws `Task '<name>' is not defined` from
 * `registerTaskAsync` otherwise (verified in build/BackgroundTask.js), and defining a task that is
 * never registered costs nothing.
 */
export async function registerMediaDrainTask(
  deps: BackgroundDrainDeps,
): Promise<BackgroundRegistration> {
  try {
    deps.platform.defineTask(MEDIA_DRAIN_TASK, () => runBoundedDrainPass(deps));

    // Point 1: ask BEFORE calling, so `restricted` is a fact we observed rather than an absence we
    // inferred from a resolved promise that means nothing.
    if ((await deps.platform.getStatusAsync()) === BACKGROUND_STATUS_RESTRICTED) {
      return { kind: 'restricted' };
    }

    await deps.platform.registerTaskAsync(MEDIA_DRAIN_TASK, {
      minimumInterval: BACKGROUND_MINIMUM_INTERVAL_MINUTES,
    });

    // Point 2: the registration is only believed once the task manager says the task is there. This
    // also covers the status FLIPPING between the read above and the call (a user toggling battery
    // restrictions mid-boot), which no amount of pre-checking can close.
    return (await deps.platform.isTaskRegisteredAsync(MEDIA_DRAIN_TASK))
      ? { kind: 'registered' }
      : { kind: 'not_registered' };
  } catch (error) {
    // A background trigger is a bonus (§5.4). It must never take the app down with it — but it must
    // not vanish either, so the error is carried out rather than logged and dropped.
    return { kind: 'failed', error };
  }
}
