// Client push-registration triggers (api/04-push §2), with expo-notifications MOCKED — no native
// module, no real network. The POST + persistence are injected ports; the test asserts the seam was
// called (or not), never a real HTTP call.
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getExpoPushTokenAsync: vi.fn() }));
vi.mock('expo-notifications', () => ({ getExpoPushTokenAsync: mocks.getExpoPushTokenAsync }));

import {
  registerPushTokenOnAppStart,
  registerPushTokenOnEnrollment,
  type PushRegistrationPorts,
} from './registration.js';

interface FakePorts extends PushRegistrationPorts {
  readonly posted: string[];
  readonly errors: unknown[];
  last: string | null;
}

function makePorts(lastRegistered: string | null = null): FakePorts {
  const posted: string[] = [];
  const errors: unknown[] = [];
  return {
    projectId: 'test-project',
    posted,
    errors,
    last: lastRegistered,
    readLastRegistered() {
      return Promise.resolve(this.last);
    },
    writeLastRegistered(token: string) {
      this.last = token;
      return Promise.resolve();
    },
    postToken(token: string) {
      posted.push(token);
      return Promise.resolve();
    },
    onError(err: unknown) {
      errors.push(err);
    },
  };
}

function tokenValue(data: string) {
  return { data, type: 'expo' as const };
}

beforeEach(() => {
  mocks.getExpoPushTokenAsync.mockReset();
});

describe('app-start trigger (api/04-push §2 (a): diff-gated)', () => {
  test('an identical token issues ZERO requests', async () => {
    mocks.getExpoPushTokenAsync.mockResolvedValue(tokenValue('ExponentPushToken[same]'));
    const ports = makePorts('ExponentPushToken[same]');
    const outcome = await registerPushTokenOnAppStart(ports);
    expect(outcome).toBe('unchanged');
    expect(ports.posted).toEqual([]);
  });

  test('a rotated token POSTs and persists the new value', async () => {
    mocks.getExpoPushTokenAsync.mockResolvedValue(tokenValue('ExponentPushToken[new]'));
    const ports = makePorts('ExponentPushToken[old]');
    const outcome = await registerPushTokenOnAppStart(ports);
    expect(outcome).toBe('sent');
    expect(ports.posted).toEqual(['ExponentPushToken[new]']);
    expect(ports.last).toBe('ExponentPushToken[new]');
    expect(mocks.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'test-project' });
  });

  test('the first-ever registration (no persisted value) POSTs', async () => {
    mocks.getExpoPushTokenAsync.mockResolvedValue(tokenValue('ExponentPushToken[first]'));
    const ports = makePorts(null);
    expect(await registerPushTokenOnAppStart(ports)).toBe('sent');
    expect(ports.posted).toEqual(['ExponentPushToken[first]']);
  });

  test('a token-acquisition failure is swallowed to skipped — startup is never blocked', async () => {
    mocks.getExpoPushTokenAsync.mockRejectedValue(new Error('offline'));
    const ports = makePorts('ExponentPushToken[old]');
    expect(await registerPushTokenOnAppStart(ports)).toBe('skipped');
    expect(ports.posted).toEqual([]);
    expect(ports.errors).toHaveLength(1);
  });

  test('a POST failure leaves the last-registered value untouched, so the next start retries', async () => {
    mocks.getExpoPushTokenAsync.mockResolvedValue(tokenValue('ExponentPushToken[new]'));
    const ports = makePorts('ExponentPushToken[old]');
    ports.postToken = () => Promise.reject(new Error('500'));
    expect(await registerPushTokenOnAppStart(ports)).toBe('skipped');
    expect(ports.last).toBe('ExponentPushToken[old]'); // NOT advanced
  });
});

describe('enrollment trigger (api/04-push §2 (b): always registers)', () => {
  test('registers even when the token equals the last-registered value (to stamp user_id)', async () => {
    mocks.getExpoPushTokenAsync.mockResolvedValue(tokenValue('ExponentPushToken[same]'));
    const ports = makePorts('ExponentPushToken[same]');
    const outcome = await registerPushTokenOnEnrollment(ports);
    expect(outcome).toBe('sent');
    expect(ports.posted).toEqual(['ExponentPushToken[same]']);
  });
});
