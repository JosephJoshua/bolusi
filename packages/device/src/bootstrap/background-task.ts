// Background tasks (`expo-background-task`): registration that reports whether it actually took,
// and one bounded pass. Shared by the media drain and the sync loop; each owns its task name and
// what a pass does. The OS decides when a task runs (WorkManager's 15-minute floor on Android,
// BGTaskScheduler on iOS), only with network, and iOS never runs one for an app the user swiped
// away. So a background run is a bonus, never something correctness depends on.
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
// So `registerBackgroundTask()` below does three things a bare call does not:
//   1. reads `getStatusAsync()` FIRST and reports `Restricted` as its own outcome, before calling;
//   2. calls `isTaskRegisteredAsync` AFTER and returns `not_registered` if the registration did not
//      take — the guard asserts its OWN coverage rather than trusting the call it just made;
//   3. returns a discriminated outcome instead of `void`, so the caller CANNOT accidentally treat
//      "restricted" as success. There is no `?? true` available to it and no silent path.
// The point is not the retry. It is that nobody may be told work runs in the background when it
// does not: 06 §5.4 is explicit that this trigger "is a bonus, never a guarantee", and the
// foreground loops are unaffected by every outcome below.
import type { TimerPort } from '@bolusi/core';

/** One background pass's time budget, after which it yields (06 §5.4). */
export const BACKGROUND_PASS_BUDGET_MS = 60_000;

/**
 * WorkManager's floor is 15 minutes and the interval is inexact (08 §2.2, research-verified), so
 * asking for less would be a number the OS ignores. 15 is the honest minimum, not an aspiration.
 */
export const BACKGROUND_MINIMUM_INTERVAL_MINUTES = 15;

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

/**
 * One bounded pass: start the work, wait for it, yield at the budget.
 *
 * `Promise.race` against a TIMER PORT rather than a `setTimeout`: the timer is the app's one wait
 * seam (03 §10) so this runs under fake timers with no sleeping (T-6). The loser's timer is
 * cancelled either way — a leaked 60 s timer per background wake is a battery bug on a device that
 * wakes every 15 minutes.
 *
 * `onBudgetSpent` lets work that can stop cleanly do so (the sync loop pauses at its next committed
 * batch); the pass then waits for that stop. Without it the pass simply returns at the budget.
 */
export async function runBoundedPass(pass: {
  readonly start: () => void;
  readonly settle: () => Promise<void>;
  readonly onBudgetSpent?: () => void;
  readonly timer: TimerPort;
}): Promise<void> {
  pass.start();
  const settled = pass.settle();
  // A holder object rather than a bare `let`: tsc's control-flow analysis cannot see that the
  // Promise executor runs synchronously, so a `let cancel` assigned inside it narrows to `never`
  // afterwards and `cancel?.()` fails to compile. The indirection is a compiler fact, not a design.
  const timer: { cancel: (() => void) | null } = { cancel: null };
  const budget = new Promise<'budget'>((resolve) => {
    timer.cancel = pass.timer.schedule(BACKGROUND_PASS_BUDGET_MS, () => resolve('budget'));
  });
  try {
    const outcome = await Promise.race([settled.then(() => 'settled' as const), budget]);
    if (outcome === 'budget' && pass.onBudgetSpent !== undefined) {
      pass.onBudgetSpent();
      await settled;
    }
  } finally {
    timer.cancel?.();
  }
}

/**
 * Define + register a background task, and REPORT whether it actually took.
 *
 * `defineTask` runs unconditionally and first: the SDK throws `Task '<name>' is not defined` from
 * `registerTaskAsync` otherwise (verified in build/BackgroundTask.js), and defining a task that is
 * never registered costs nothing. The platform's `defineTask` is a no-op for a name already defined,
 * so a task defined at module scope (for an OS launch straight into the background) can be
 * registered later through this same function.
 */
export async function registerBackgroundTask(
  platform: BackgroundTaskPlatform,
  name: string,
  executor: () => Promise<void>,
): Promise<BackgroundRegistration> {
  try {
    platform.defineTask(name, executor);

    // Point 1: ask BEFORE calling, so `restricted` is a fact we observed rather than an absence we
    // inferred from a resolved promise that means nothing.
    if ((await platform.getStatusAsync()) === BACKGROUND_STATUS_RESTRICTED) {
      return { kind: 'restricted' };
    }

    await platform.registerTaskAsync(name, {
      minimumInterval: BACKGROUND_MINIMUM_INTERVAL_MINUTES,
    });

    // Point 2: the registration is only believed once the task manager says the task is there. This
    // also covers the status FLIPPING between the read above and the call (a user toggling battery
    // restrictions mid-boot), which no amount of pre-checking can close.
    return (await platform.isTaskRegisteredAsync(name))
      ? { kind: 'registered' }
      : { kind: 'not_registered' };
  } catch (error) {
    // A background trigger is a bonus. It must never take the app down with it — but it must not
    // vanish either, so the error is carried out rather than logged and dropped.
    return { kind: 'failed', error };
  }
}

// ── THE HOST: one task executor, defined before boot, driving at most one client ────────────────
//
// `TaskManager.defineTask` has to run at module scope (index.ts): when the OS launches the app
// straight into the background, expo-task-manager dispatches the task right after the bundle
// loads, and a task with no executor at that moment is UNREGISTERED (build/TaskManager.js), so it
// would never run again. The clients are built later. The host bridges the two, and decides what a
// pass drives:
//
//   - the foreground client, when Root has started one (the app is open or merely backgrounded);
//   - otherwise a headless client, built from the shared boot for this pass only and stopped after
//     it. On Android this is a killed app woken by WorkManager: the JS runs but Root never mounts.
//
// Never both at once. A foreground client `claim`s the host before it starts: that stops a
// headless pass at its next safe point and waits for it to end, so two loops never work one
// database. A pass that starts while a foreground client is starting waits for it to attach.

/** How long a pass waits for a foreground client that has claimed the host but not yet attached. */
export const CLIENT_BOOT_WAIT_MS = 20_000;

/** What a pass drives: a started client's background surface. */
export interface BackgroundPassTarget {
  /** Kick off the work for this pass. */
  requestBackground(): void;
  /** Resolves when that work (and any coalesced rerun) is done. */
  settle(): Promise<void>;
  /** Stop at the next safe point, for a headless pass out of time or handing over to the open app. */
  pause?(): void;
}

/** A client built for one headless pass. `stop` runs after the pass, however it ended. */
export interface HeadlessPass {
  readonly target: BackgroundPassTarget;
  stop(): void;
}

/** The foreground client's hold on the host, from just before it starts until it stops. */
export interface BackgroundLease {
  /** The client is started; passes drive it from now on. */
  attach(target: BackgroundPassTarget): void;
  /**
   * The client stopped (or failed to start). `settled` resolves once its loop has finished the
   * work in flight; nothing else drives the database until then. Idempotent; a stale lease's
   * release does nothing.
   */
  release(settled?: Promise<void>): void;
}

export interface BackgroundHost {
  /** Call before a foreground client starts: ends any headless pass first. */
  claim(): Promise<BackgroundLease>;
  /** The task executor: one bounded pass. Never rejects; failures go to `onError`. */
  runPass(): Promise<void>;
}

/** What the composition root hands a client so it can register its task. */
export interface BackgroundBinding {
  readonly platform: BackgroundTaskPlatform;
  readonly host: BackgroundHost;
}

export function createBackgroundHost(deps: {
  readonly timer: TimerPort;
  /** Build and start a client for one pass, or `null` when there is nothing to drive (unenrolled). */
  readonly startHeadless?: () => Promise<HeadlessPass | null>;
  readonly onError?: (error: unknown) => void;
}): BackgroundHost {
  const { timer } = deps;
  let lease: { target: BackgroundPassTarget | null } | null = null;
  const waiting = new Set<(target: BackgroundPassTarget | null) => void>();
  let headless: { pass: HeadlessPass | null; done: Promise<void> } | null = null;
  /** A released foreground client's last work in flight. Never rejects. */
  let releasing: Promise<void> = Promise.resolve();

  const wake = (target: BackgroundPassTarget | null): void => {
    for (const done of waiting) done(target);
    waiting.clear();
  };

  function waitForAttach(): Promise<BackgroundPassTarget | null> {
    return new Promise((resolve) => {
      const cancel = timer.schedule(CLIENT_BOOT_WAIT_MS, () => {
        waiting.delete(done);
        resolve(null);
      });
      const done = (target: BackgroundPassTarget | null): void => {
        cancel();
        resolve(target);
      };
      waiting.add(done);
    });
  }

  /**
   * One bounded pass. Only a headless client is paused at the budget: the open app's loops keep
   * going (the pass just stops waiting for them), since cutting them short would drop the open
   * app's own triggers for nothing.
   */
  function drive(target: BackgroundPassTarget, headlessTarget: boolean): Promise<void> {
    return runBoundedPass({
      start: () => target.requestBackground(),
      settle: () => target.settle(),
      ...(headlessTarget && target.pause !== undefined
        ? { onBudgetSpent: () => target.pause?.() }
        : {}),
      timer,
    });
  }

  async function runHeadless(
    run: { pass: HeadlessPass | null },
    start: () => Promise<HeadlessPass | null>,
  ): Promise<void> {
    const pass = await start();
    if (pass === null) return;
    run.pass = pass;
    try {
      // A foreground client may have claimed the host while this one was booting.
      if (lease === null) await drive(pass.target, true);
    } finally {
      pass.stop();
    }
  }

  return {
    async claim() {
      const current: { target: BackgroundPassTarget | null } = { target: null };
      lease = current;
      if (headless !== null) {
        headless.pass?.target.pause?.();
        await headless.done;
      }
      await releasing;
      return {
        attach(target) {
          if (lease !== current) return;
          current.target = target;
          wake(target);
        },
        release(settled) {
          if (lease !== current) return;
          lease = null;
          if (settled !== undefined) {
            const previous = releasing;
            releasing = Promise.all([previous, settled.catch(() => undefined)]).then(
              () => undefined,
            );
          }
          wake(null);
        },
      };
    },

    async runPass() {
      try {
        if (headless !== null) return await headless.done;
        if (lease !== null) {
          const target = lease.target ?? (await waitForAttach());
          if (target !== null) await drive(target, false);
          return;
        }
        await releasing;
        // A foreground client may have claimed, or another pass started, while we waited.
        if (lease !== null || headless !== null) return;
        if (deps.startHeadless === undefined) return;
        const run: { pass: HeadlessPass | null; done: Promise<void> } = {
          pass: null,
          done: Promise.resolve(),
        };
        headless = run;
        // `done` never rejects, so a foreground `claim` that awaits it cannot be failed by the pass.
        run.done = runHeadless(run, deps.startHeadless)
          .catch((error: unknown) => deps.onError?.(error))
          .finally(() => {
            if (headless === run) headless = null;
          });
        await run.done;
      } catch (error) {
        deps.onError?.(error);
      }
    },
  };
}

/** Define + register a task whose executor is the host's pass, reporting whether it took. */
export function registerHostTask(
  binding: BackgroundBinding,
  name: string,
): Promise<BackgroundRegistration> {
  return registerBackgroundTask(binding.platform, name, () => binding.host.runPass());
}
