// The headless client a background pass builds. The shared boot is tested in test/bootstrap.test.ts.
import { describe, expect, test } from 'vitest';

import { headlessPass, type HeadlessClient } from './headless.js';

function fakeClient(options: { failStart?: boolean } = {}) {
  const calls: string[] = [];
  const client: HeadlessClient = {
    startForBackgroundPass: () => {
      calls.push('start');
      return options.failStart === true ? Promise.reject(new Error('hydrate')) : Promise.resolve();
    },
    requestBackground: () => calls.push('request'),
    settle: () => Promise.resolve(),
    stop: () => calls.push('stop'),
  };
  return { client, calls };
}

describe('headlessPass', () => {
  test('boots, builds the client over that boot, and starts it for the pass only', async () => {
    const { client, calls } = fakeClient();
    const seen: string[] = [];
    const start = headlessPass(
      () => Promise.resolve('app'),
      (app) => {
        seen.push(app);
        return client;
      },
    );
    const pass = await start();
    expect(seen).toEqual(['app']);
    expect(calls).toEqual(['start']);
    expect(pass?.target).toBe(client);
    pass?.stop();
    expect(calls).toEqual(['start', 'stop']);
  });

  test('an unenrolled device builds nothing', async () => {
    const start = headlessPass(
      () => Promise.resolve('app'),
      () => null,
    );
    expect(await start()).toBeNull();
  });

  test('a client that fails to start is stopped before the error goes up', async () => {
    const { client, calls } = fakeClient({ failStart: true });
    const start = headlessPass(
      () => Promise.resolve('app'),
      () => client,
    );
    await expect(start()).rejects.toThrow('hydrate');
    expect(calls).toEqual(['start', 'stop']);
  });
});
