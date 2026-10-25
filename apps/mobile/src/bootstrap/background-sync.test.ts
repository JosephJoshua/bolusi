// api/01-sync §5 (d): the module-scope task drives whichever client the app booted, for one bounded
// pass, and does nothing when no client boots. The FakeTimer fires only when told (T-6).
import { describe, expect, test } from 'vitest';

import { FakeTimer } from '../media/_harness.test.js';
import { fakeBackgroundPlatform } from './_background-platform.test.js';
import {
  createBackgroundSyncHost,
  registerSyncTask,
  SYNC_BACKGROUND_TASK,
  type BackgroundSyncTarget,
} from './background-sync.js';

function fakeTarget() {
  const calls: string[] = [];
  let release: () => void = () => undefined;
  let held = false;
  const target: BackgroundSyncTarget = {
    requestBackground: () => calls.push('request'),
    pause: () => {
      calls.push('pause');
      release();
    },
    settle: () => {
      calls.push('settle');
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

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('the background sync pass', () => {
  test('drives the attached client and cancels its budget timer when the cycle settles', async () => {
    const timer = new FakeTimer();
    const host = createBackgroundSyncHost(timer);
    const { target, calls } = fakeTarget();
    host.attach(target);

    await host.runPass();

    expect(calls).toEqual(['request', 'settle']);
    expect(timer.pendingCount).toBe(0);
  });

  test('pauses the client at the budget and waits for it to stop', async () => {
    const timer = new FakeTimer();
    const host = createBackgroundSyncHost(timer);
    const { target, calls, holdUntilPaused } = fakeTarget();
    holdUntilPaused();
    host.attach(target);

    let finished = false;
    const pass = host.runPass().then(() => (finished = true));
    await flush();
    expect(finished).toBe(false);

    timer.runPending(); // the 60 s budget
    await pass;
    expect(calls).toEqual(['request', 'settle', 'pause']);
  });

  test('waits for a client that boots after the OS launched the task', async () => {
    const timer = new FakeTimer();
    const host = createBackgroundSyncHost(timer);
    const { target, calls } = fakeTarget();

    const pass = host.runPass();
    await flush();
    expect(calls).toEqual([]);

    host.attach(target);
    await pass;
    expect(calls).toEqual(['request', 'settle']);
    expect(timer.pendingCount).toBe(0); // the boot wait was cancelled
  });

  test('does nothing when no client boots in time', async () => {
    const timer = new FakeTimer();
    const host = createBackgroundSyncHost(timer);
    const { target, calls } = fakeTarget();

    const pass = host.runPass();
    await flush();
    timer.runPending(); // the boot wait expires
    await pass;

    host.attach(target); // a late client is not driven by a pass that already gave up
    await flush();
    expect(calls).toEqual([]);
  });

  test('a stopped client is detached, and detaching an old client keeps the new one', async () => {
    const timer = new FakeTimer();
    const host = createBackgroundSyncHost(timer);
    const first = fakeTarget();
    const second = fakeTarget();

    const detachFirst = host.attach(first.target);
    host.attach(second.target);
    detachFirst();
    await host.runPass();
    expect(first.calls).toEqual([]);
    expect(second.calls).toEqual(['request', 'settle']);
  });
});

describe('registering the sync task', () => {
  test('registers under the sync task name with the host pass as its executor', async () => {
    const timer = new FakeTimer();
    const host = createBackgroundSyncHost(timer);
    const platform = fakeBackgroundPlatform({});
    const { target, calls } = fakeTarget();
    host.attach(target);

    expect(await registerSyncTask({ platform, host })).toEqual({ kind: 'registered' });
    expect(platform.registered.map((entry) => entry.name)).toEqual([SYNC_BACKGROUND_TASK]);

    await platform.executors.get(SYNC_BACKGROUND_TASK)?.();
    expect(calls).toEqual(['request', 'settle']);
  });
});
