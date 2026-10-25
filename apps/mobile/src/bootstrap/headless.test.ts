// One boot per process for the UI and the background tasks, and the headless client a pass builds.
import { describe, expect, test } from 'vitest';

import { headlessPass, shareBoot, type HeadlessClient } from './headless.js';

describe('shareBoot', () => {
  test('every caller gets the same boot, run once', async () => {
    let boots = 0;
    const boot = shareBoot(async () => {
      boots += 1;
      return { connection: boots };
    });
    const [a, b] = await Promise.all([boot(), boot()]);
    expect(a).toBe(b); // without a refresh, the very same object
    expect(await boot()).toBe(a);
    expect(boots).toBe(1);
  });

  test('each caller gets the shared boot refreshed, so a later enrollment is seen', async () => {
    let boots = 0;
    let enrolledAs: string | null = null;
    const boot = shareBoot(
      async () => {
        boots += 1;
        return { connection: 1, deviceId: null as string | null };
      },
      async (app) => ({ ...app, deviceId: enrolledAs }),
    );
    expect((await boot()).deviceId).toBeNull();
    enrolledAs = 'device-1';
    const later = await boot();
    expect(later).toEqual({ connection: 1, deviceId: 'device-1' });
    expect(boots).toBe(1);
  });

  test('a failed boot is not cached, so the next caller tries again', async () => {
    let boots = 0;
    const boot = shareBoot(async () => {
      boots += 1;
      if (boots === 1) throw new Error('keychain locked');
      return 'booted';
    });
    await expect(boot()).rejects.toThrow('keychain locked');
    await expect(boot()).resolves.toBe('booted');
    expect(boots).toBe(2);
  });
});

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
