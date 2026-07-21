// 06-media-pipeline §5.2(d)/§5.4 — the background trigger, and the trap it exists to close.
//
// `BackgroundTask.registerTaskAsync` RESOLVES HAVING REGISTERED NOTHING when the platform reports
// `Restricted`. That is not a doc claim: it is `expo-background-task@57.0.2`'s own source, which
// `console.warn`s and `return`s. It is `setNotificationChannelAsync`'s exact shape (task 59) and it
// fires on shipped configurations — an iOS simulator, Expo Go, and any Android device whose user or
// OEM battery manager has restricted background work.
//
// So the tests below are about a LIE, not a crash: what must never happen is anybody being told
// uploads are queued in the background when they are not. Each outcome is asserted by the SIDE
// EFFECT it did or did not have (was `registerTaskAsync` called at all?), never by the return value
// alone — because the return value is precisely the thing that lies.
import { describe, expect, test } from 'vitest';

import { FakeTimer } from './_harness.test.js';
import {
  BACKGROUND_MINIMUM_INTERVAL_MINUTES,
  BACKGROUND_PASS_BUDGET_MS,
  BACKGROUND_STATUS_RESTRICTED,
  MEDIA_DRAIN_TASK,
  registerMediaDrainTask,
  runBoundedDrainPass,
  type BackgroundTaskPlatform,
} from './background-task.js';

const AVAILABLE = 2;

/**
 * A platform faithful to the SDK's real behaviour, including the silent return.
 *
 * `registerTaskAsync` here does what upstream does: when the status is `Restricted` the app never
 * gets that far (the real function checks first and returns), and when it is not, registration
 * takes. `registrationTakes: false` models the residual case the guard's second half exists for —
 * a status that flipped between the read and the call.
 */
function fakePlatform(options: {
  status?: number;
  registrationTakes?: boolean;
  throwOnDefine?: boolean;
}): BackgroundTaskPlatform & {
  defined: string[];
  registered: { name: string; minimumInterval: number }[];
  live: Set<string>;
} {
  const defined: string[] = [];
  const registered: { name: string; minimumInterval: number }[] = [];
  const live = new Set<string>();
  return {
    defined,
    registered,
    live,
    defineTask(name) {
      if (options.throwOnDefine === true) throw new Error('task manager unavailable');
      defined.push(name);
    },
    getStatusAsync: () => Promise.resolve(options.status ?? AVAILABLE),
    registerTaskAsync: (name, taskOptions) => {
      registered.push({ name, minimumInterval: taskOptions.minimumInterval });
      if (options.registrationTakes !== false) live.add(name);
      return Promise.resolve();
    },
    isTaskRegisteredAsync: (name) => Promise.resolve(live.has(name)),
  };
}

function deps(
  platform: BackgroundTaskPlatform,
  extra: Partial<{ settle: () => Promise<void> }> = {},
) {
  const drains: string[] = [];
  const timer = new FakeTimer();
  return {
    drains,
    timer,
    value: {
      platform,
      requestDrain: (reason: string) => drains.push(reason),
      settle: extra.settle ?? ((): Promise<void> => Promise.resolve()),
      timer,
    },
  };
}

describe('§5.4 — registration reports what actually happened', () => {
  test('an AVAILABLE platform registers, at WorkManager`s 15-minute floor', async () => {
    const platform = fakePlatform({});
    const rig = deps(platform);
    const outcome = await registerMediaDrainTask(rig.value as never);

    expect(outcome).toEqual({ kind: 'registered' });
    expect(platform.defined).toEqual([MEDIA_DRAIN_TASK]);
    expect(platform.registered).toEqual([
      { name: MEDIA_DRAIN_TASK, minimumInterval: BACKGROUND_MINIMUM_INTERVAL_MINUTES },
    ]);
    // Asking for less than 15 would be a number the OS ignores (08 §2.2, research-verified).
    expect(BACKGROUND_MINIMUM_INTERVAL_MINUTES).toBe(15);
  });

  test('THE TRAP: a RESTRICTED platform yields `restricted`, and `registerTaskAsync` is NEVER called', async () => {
    // The upstream function would have resolved here having done nothing. The assertion that
    // matters is the SIDE EFFECT — `registered` is empty — because the resolved promise is exactly
    // what a naive caller would have believed.
    const platform = fakePlatform({ status: BACKGROUND_STATUS_RESTRICTED });
    const outcome = await registerMediaDrainTask(deps(platform).value as never);

    expect(outcome).toEqual({ kind: 'restricted' });
    expect(platform.registered).toEqual([]);
    // The task is still DEFINED — defining costs nothing, and a later re-registration attempt (a
    // user turning battery optimisation off) must not need a process restart to find it.
    expect(platform.defined).toEqual([MEDIA_DRAIN_TASK]);
  });

  test('a registration that does NOT take is reported `not_registered`, not `registered`', async () => {
    // The residual case a pre-check cannot close: the status flipped between the read and the call.
    // Believing the resolved promise here is how a guard silently checks nothing (§2.11).
    const platform = fakePlatform({ registrationTakes: false });
    const outcome = await registerMediaDrainTask(deps(platform).value as never);

    expect(outcome).toEqual({ kind: 'not_registered' });
    expect(platform.registered).toHaveLength(1); // it was attempted…
    expect(platform.live.size).toBe(0); // …and it did not take.
  });

  test('`restricted` and `not_registered` stay DISTINCT — one is expected, one is a surprise', async () => {
    const restricted = await registerMediaDrainTask(
      deps(fakePlatform({ status: BACKGROUND_STATUS_RESTRICTED })).value as never,
    );
    const notRegistered = await registerMediaDrainTask(
      deps(fakePlatform({ registrationTakes: false })).value as never,
    );
    expect(restricted.kind).not.toBe(notRegistered.kind);
  });

  test('a throwing platform yields `failed` WITH the error — a bonus trigger never takes the app down', async () => {
    const outcome = await registerMediaDrainTask(
      deps(fakePlatform({ throwOnDefine: true })).value as never,
    );
    expect(outcome.kind).toBe('failed');
    expect((outcome as { error: Error }).error.message).toBe('task manager unavailable');
  });
});

describe('§5.4 — the bounded pass', () => {
  test('a pass triggers a drain and completes when the loop settles', async () => {
    const platform = fakePlatform({});
    const rig = deps(platform);
    await runBoundedDrainPass(rig.value as never);
    expect(rig.drains).toEqual(['background_task']);
    // The budget timer is cancelled on the way out — a leaked 60 s timer per background wake, on a
    // device that wakes every 15 minutes, is a battery bug.
    expect(rig.timer.pendingCount).toBe(0);
  });

  test('a pass that outlives the 60 s budget YIELDS rather than hanging', async () => {
    // Expiring is not a failure and nothing is rolled back: the drain is chunk-resumable by
    // construction (the server's `receivedChunks` is ground truth), so the next trigger picks up
    // exactly where this one stopped.
    let stuck: (() => void) | null = null;
    const rig = deps(fakePlatform({}), {
      settle: () =>
        new Promise<void>((resolve) => {
          stuck = resolve;
        }),
    });

    const pass = runBoundedDrainPass(rig.value as never);
    // Nothing resolves the drain; only the budget timer can end this.
    rig.timer.runPending();
    await pass;

    expect(BACKGROUND_PASS_BUDGET_MS).toBe(60_000);
    expect(stuck).not.toBeNull(); // the drain really was still in flight when the pass returned
  });
});
