// The background host: one module-scope executor that drives the foreground client when Root has
// started one, and otherwise boots a headless client for the pass (a killed Android app woken by
// WorkManager). Never both at once. The FakeTimer fires only when told (T-6).
import { describe, expect, test } from 'vitest';

import { FakeTimer } from '../media/_harness.test.js';
import { fakeBackgroundPlatform } from './_background-platform.test.js';
import { registerSyncTask, SYNC_BACKGROUND_TASK } from './background-sync.js';
import {
  createBackgroundHost,
  type BackgroundPassTarget,
  type HeadlessPass,
} from './background-task.js';

function fakeTarget(name = 'client', calls: string[] = []) {
  let release: () => void = () => undefined;
  let held = false;
  const target: BackgroundPassTarget = {
    requestBackground: () => calls.push(`${name}:request`),
    pause: () => {
      calls.push(`${name}:pause`);
      release();
    },
    settle: () => {
      calls.push(`${name}:settle`);
      return held ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
    },
  };
  return {
    target,
    calls,
    /** The cycle runs until paused, like a long first pull. */
    holdUntilPaused: () => {
      held = true;
    },
  };
}

/** A headless factory that records each client it built and when it was stopped. */
function fakeHeadless(options: { hold?: boolean; enrolled?: boolean } = {}) {
  const log: string[] = [];
  let boots = 0;
  let finishBoot: (() => void) | null = null;
  let bootGate: Promise<void> = Promise.resolve();
  const startHeadless = async (): Promise<HeadlessPass | null> => {
    boots += 1;
    await bootGate;
    if (options.enrolled === false) return null;
    const client = fakeTarget('headless', log);
    if (options.hold === true) client.holdUntilPaused();
    return { target: client.target, stop: () => log.push('headless:stop') };
  };
  return {
    startHeadless,
    log,
    boots: () => boots,
    /** Hold the next boot open until `releaseBoot()`. */
    gateBoot: () => {
      bootGate = new Promise<void>((resolve) => (finishBoot = resolve));
    },
    releaseBoot: () => finishBoot?.(),
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

describe('a pass with the app open', () => {
  test('drives the attached client and cancels its budget timer when the cycle settles', async () => {
    const timer = new FakeTimer();
    const headless = fakeHeadless();
    const host = createBackgroundHost({ timer, startHeadless: headless.startHeadless });
    const { target, calls } = fakeTarget();
    (await host.claim()).attach(target);

    await host.runPass();

    expect(calls).toEqual(['client:request', 'client:settle']);
    expect(headless.boots()).toBe(0);
    expect(timer.pendingCount).toBe(0);
  });

  test('at the budget the pass stops waiting, but never cuts the open app`s own loop short', async () => {
    const timer = new FakeTimer();
    const host = createBackgroundHost({ timer });
    const { target, calls, holdUntilPaused } = fakeTarget();
    holdUntilPaused();
    (await host.claim()).attach(target);

    let finished = false;
    const pass = host.runPass().then(() => (finished = true));
    await flush();
    expect(finished).toBe(false);

    timer.runPending(); // the 60 s budget
    await pass;
    expect(calls).toEqual(['client:request', 'client:settle']); // no pause
  });

  test('a stopped client`s last work finishes before a headless pass touches the database', async () => {
    const timer = new FakeTimer();
    const headless = fakeHeadless();
    const host = createBackgroundHost({ timer, startHeadless: headless.startHeadless });
    const lease = await host.claim();
    lease.attach(fakeTarget().target);

    let finishLastBatch: () => void = () => undefined;
    lease.release(new Promise<void>((resolve) => (finishLastBatch = resolve)));
    const pass = host.runPass();
    await flush();
    expect(headless.boots()).toBe(0); // still waiting for the retired loop

    finishLastBatch();
    await pass;
    expect(headless.boots()).toBe(1);
  });

  test('a pass while the client is still starting waits for it rather than booting another', async () => {
    const timer = new FakeTimer();
    const headless = fakeHeadless();
    const host = createBackgroundHost({ timer, startHeadless: headless.startHeadless });
    const { target, calls } = fakeTarget();
    const lease = await host.claim();

    const pass = host.runPass();
    await flush();
    expect(calls).toEqual([]);

    lease.attach(target);
    await pass;
    expect(calls).toEqual(['client:request', 'client:settle']);
    expect(headless.boots()).toBe(0);
    expect(timer.pendingCount).toBe(0); // the attach wait was cancelled
  });

  test('a client that claimed and never attaches is given up on, without a headless boot', async () => {
    const timer = new FakeTimer();
    const headless = fakeHeadless();
    const host = createBackgroundHost({ timer, startHeadless: headless.startHeadless });
    const lease = await host.claim();

    const pass = host.runPass();
    await flush();
    timer.runPending(); // the attach wait expires
    await pass;

    const late = fakeTarget();
    lease.attach(late.target); // a late client is not driven by a pass that already gave up
    await flush();
    expect(late.calls).toEqual([]);
    expect(headless.boots()).toBe(0);
  });

  test('a released lease hands passes back to headless, and a stale release changes nothing', async () => {
    const timer = new FakeTimer();
    const headless = fakeHeadless();
    const host = createBackgroundHost({ timer, startHeadless: headless.startHeadless });
    const first = fakeTarget('first');
    const second = fakeTarget('second');

    const firstLease = await host.claim();
    firstLease.attach(first.target);
    const secondLease = await host.claim(); // Root remounted and started a new client
    secondLease.attach(second.target);
    firstLease.release(); // the old client's stop must not detach the new one
    await host.runPass();
    expect(first.calls).toEqual([]);
    expect(second.calls).toEqual(['second:request', 'second:settle']);

    secondLease.release();
    await host.runPass();
    expect(headless.boots()).toBe(1);
  });
});

describe('a pass with no app open (killed app woken by the OS)', () => {
  test('a headless client is paused at the budget and stopped once it has', async () => {
    const timer = new FakeTimer();
    const headless = fakeHeadless({ hold: true });
    const host = createBackgroundHost({ timer, startHeadless: headless.startHeadless });

    const pass = host.runPass();
    await flush();
    timer.runPending(); // the 60 s budget
    await pass;
    expect(headless.log).toEqual([
      'headless:request',
      'headless:settle',
      'headless:pause',
      'headless:stop',
    ]);
  });

  test('boots a headless client, drives one pass, and stops it', async () => {
    const timer = new FakeTimer();
    const headless = fakeHeadless();
    const host = createBackgroundHost({ timer, startHeadless: headless.startHeadless });

    await host.runPass();

    expect(headless.log).toEqual(['headless:request', 'headless:settle', 'headless:stop']);
    expect(timer.pendingCount).toBe(0);
  });

  test('an unenrolled device has nothing to drive', async () => {
    const headless = fakeHeadless({ enrolled: false });
    const host = createBackgroundHost({
      timer: new FakeTimer(),
      startHeadless: headless.startHeadless,
    });
    await host.runPass();
    expect(headless.boots()).toBe(1);
    expect(headless.log).toEqual([]);
  });

  test('a second pass while one runs joins it instead of building a second client', async () => {
    const timer = new FakeTimer();
    const headless = fakeHeadless({ hold: true });
    const host = createBackgroundHost({ timer, startHeadless: headless.startHeadless });

    const first = host.runPass();
    await flush();
    const second = host.runPass();
    timer.runPending(); // budget
    await Promise.all([first, second]);
    expect(headless.boots()).toBe(1);
    expect(headless.log.filter((entry) => entry === 'headless:stop')).toHaveLength(1);
  });

  test('a failed boot is reported, the pass resolves, and the next one tries again', async () => {
    const errors: unknown[] = [];
    let attempts = 0;
    const host = createBackgroundHost({
      timer: new FakeTimer(),
      startHeadless: () => {
        attempts += 1;
        return Promise.reject(new Error('keychain locked'));
      },
      onError: (error) => errors.push(error),
    });
    await host.runPass();
    await host.runPass();
    expect(attempts).toBe(2);
    expect(errors.map((error) => (error as Error).message)).toEqual([
      'keychain locked',
      'keychain locked',
    ]);
    // A failed pass does not wedge the foreground either.
    await expect(host.claim()).resolves.toBeDefined();
  });
});

describe('handover when the user opens the app during a headless pass', () => {
  test('the claim pauses the headless client and resolves only after it stopped', async () => {
    const timer = new FakeTimer();
    const headless = fakeHeadless({ hold: true });
    const host = createBackgroundHost({ timer, startHeadless: headless.startHeadless });

    const pass = host.runPass();
    await flush();
    expect(headless.log).toEqual(['headless:request', 'headless:settle']);

    let claimed = false;
    const claim = host.claim().then((lease) => {
      claimed = true;
      expect(headless.log).toContain('headless:stop'); // stopped BEFORE the foreground starts
      return lease;
    });
    const lease = await claim;
    await pass;
    expect(claimed).toBe(true);
    expect(headless.log).toEqual([
      'headless:request',
      'headless:settle',
      'headless:pause',
      'headless:stop',
    ]);

    // From now on passes drive the foreground client.
    const fg = fakeTarget('fg');
    lease.attach(fg.target);
    await host.runPass();
    expect(fg.calls).toEqual(['fg:request', 'fg:settle']);
    expect(headless.boots()).toBe(1);
  });

  test('a claim while the headless client is still booting means it never runs', async () => {
    const timer = new FakeTimer();
    const headless = fakeHeadless();
    headless.gateBoot();
    const host = createBackgroundHost({ timer, startHeadless: headless.startHeadless });

    const pass = host.runPass();
    await flush();
    const claim = host.claim();
    headless.releaseBoot();
    await claim;
    await pass;
    expect(headless.log).toEqual(['headless:stop']);
  });
});

describe('registering the sync task', () => {
  test('registers under the sync task name with the host pass as its executor', async () => {
    const host = createBackgroundHost({ timer: new FakeTimer() });
    const platform = fakeBackgroundPlatform({});
    const { target, calls } = fakeTarget();
    (await host.claim()).attach(target);

    expect(await registerSyncTask({ platform, host })).toEqual({ kind: 'registered' });
    expect(platform.registered.map((entry) => entry.name)).toEqual([SYNC_BACKGROUND_TASK]);

    await platform.executors.get(SYNC_BACKGROUND_TASK)?.();
    expect(calls).toEqual(['client:request', 'client:settle']);
  });
});
