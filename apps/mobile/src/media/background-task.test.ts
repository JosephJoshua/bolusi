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

import { fakeBackgroundPlatform as fakePlatform } from '../bootstrap/_background-platform.test.js';
import {
  BACKGROUND_MINIMUM_INTERVAL_MINUTES,
  BACKGROUND_PASS_BUDGET_MS,
  BACKGROUND_STATUS_RESTRICTED,
  createBackgroundHost,
  type BackgroundTaskPlatform,
} from '../bootstrap/background-task.js';
import { FakeTimer } from './_harness.test.js';
import { MEDIA_DRAIN_TASK, registerMediaDrainTask } from './background-task.js';

/** A drain target the pass drives, attached to a host as the open app's media client would be. */
async function binding(
  platform: BackgroundTaskPlatform,
  extra: Partial<{ settle: () => Promise<void> }> = {},
) {
  const drains: string[] = [];
  const timer = new FakeTimer();
  const host = createBackgroundHost({ timer });
  (await host.claim()).attach({
    requestBackground: () => drains.push('background_task'),
    settle: extra.settle ?? ((): Promise<void> => Promise.resolve()),
  });
  return { drains, timer, value: { platform, host } };
}

describe('§5.4 — registration reports what actually happened', () => {
  test('an AVAILABLE platform registers, at WorkManager`s 15-minute floor', async () => {
    const platform = fakePlatform({});
    const outcome = await registerMediaDrainTask((await binding(platform)).value);

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
    const outcome = await registerMediaDrainTask((await binding(platform)).value);

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
    const outcome = await registerMediaDrainTask((await binding(platform)).value);

    expect(outcome).toEqual({ kind: 'not_registered' });
    expect(platform.registered).toHaveLength(1); // it was attempted…
    expect(platform.live.size).toBe(0); // …and it did not take.
  });

  test('`restricted` and `not_registered` stay DISTINCT — one is expected, one is a surprise', async () => {
    const restricted = await registerMediaDrainTask(
      (await binding(fakePlatform({ status: BACKGROUND_STATUS_RESTRICTED }))).value,
    );
    const notRegistered = await registerMediaDrainTask(
      (await binding(fakePlatform({ registrationTakes: false }))).value,
    );
    expect(restricted.kind).not.toBe(notRegistered.kind);
  });

  test('a throwing platform yields `failed` WITH the error — a bonus trigger never takes the app down', async () => {
    const outcome = await registerMediaDrainTask(
      (await binding(fakePlatform({ throwOnDefine: true }))).value,
    );
    expect(outcome.kind).toBe('failed');
    expect((outcome as { error: Error }).error.message).toBe('task manager unavailable');
  });
});

describe('§5.4 — the bounded pass', () => {
  test('the task triggers a drain and completes when the loop settles', async () => {
    const platform = fakePlatform({});
    const rig = await binding(platform);
    await registerMediaDrainTask(rig.value);
    await platform.executors.get(MEDIA_DRAIN_TASK)?.();
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
    const platform = fakePlatform({});
    const rig = await binding(platform, {
      settle: () =>
        new Promise<void>((resolve) => {
          stuck = resolve;
        }),
    });
    await registerMediaDrainTask(rig.value);

    const pass = platform.executors.get(MEDIA_DRAIN_TASK)?.();
    await new Promise((resolve) => setImmediate(resolve));
    // Nothing resolves the drain; only the budget timer can end this.
    rig.timer.runPending();
    await pass;

    expect(BACKGROUND_PASS_BUDGET_MS).toBe(60_000);
    expect(stuck).not.toBeNull(); // the drain really was still in flight when the pass returned
  });
});
