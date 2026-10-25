// A shared `BackgroundTaskPlatform` fake for the media drain and sync background suites, plus its own
// check. A `.test.ts` for the same reason as media/_harness.test.ts: the lane's include glob.
import { describe, expect, test } from 'vitest';

import { BACKGROUND_STATUS_RESTRICTED, type BackgroundTaskPlatform } from './background-task.js';

const AVAILABLE = 2;

/**
 * A platform faithful to the SDK's real behaviour, including the silent return.
 *
 * `registerTaskAsync` here does what upstream does: when the status is `Restricted` the app never
 * gets that far (the real function checks first and returns), and when it is not, registration
 * takes. `registrationTakes: false` models the residual case the guard's second half exists for —
 * a status that flipped between the read and the call. `executors` keeps each defined executor so a
 * test can run the task the way the OS would.
 */
export function fakeBackgroundPlatform(options: {
  status?: number;
  registrationTakes?: boolean;
  throwOnDefine?: boolean;
}): BackgroundTaskPlatform & {
  defined: string[];
  executors: Map<string, () => Promise<void>>;
  registered: { name: string; minimumInterval: number }[];
  live: Set<string>;
} {
  const defined: string[] = [];
  const executors = new Map<string, () => Promise<void>>();
  const registered: { name: string; minimumInterval: number }[] = [];
  const live = new Set<string>();
  return {
    defined,
    executors,
    registered,
    live,
    defineTask(name, executor) {
      if (options.throwOnDefine === true) throw new Error('task manager unavailable');
      defined.push(name);
      executors.set(name, executor);
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

describe('fakeBackgroundPlatform behaves like the SDK it stands in for', () => {
  test('reports the status it was given and registers only when the registration takes', async () => {
    const restricted = fakeBackgroundPlatform({ status: BACKGROUND_STATUS_RESTRICTED });
    expect(await restricted.getStatusAsync()).toBe(BACKGROUND_STATUS_RESTRICTED);

    const flipped = fakeBackgroundPlatform({ registrationTakes: false });
    await flipped.registerTaskAsync('t', { minimumInterval: 15 });
    expect(await flipped.isTaskRegisteredAsync('t')).toBe(false);

    const available = fakeBackgroundPlatform({});
    await available.registerTaskAsync('t', { minimumInterval: 15 });
    expect(await available.isTaskRegisteredAsync('t')).toBe(true);
  });
});
