// The production Expo transport + the FAIL-CLOSED push-port builder (task 134; api/04-push §7).
// No network and no DB — a stubbed `fetch` proves the request shape; `pushPortFromConfig`'s throw
// is the boot guard that stops the server running with a silent (dead) push port.
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { ServerConfig } from '../config.js';
import { EXPO_SEND_URL } from './expo-sender.js';
import { expoFetchTransport, pushPortFromConfig } from './expo-transport.js';

const baseConfig: ServerConfig = { databaseUrl: 'postgres://x', port: 3000 };

describe('pushPortFromConfig — fail closed on absent EXPO_ACCESS_TOKEN', () => {
  test('throws (loud, at boot) when the token is absent — a silent no-op is the task-134 defect', () => {
    // Falsification: if the builder returned a no-op port instead of throwing, this reds.
    expect(() => pushPortFromConfig(baseConfig)).toThrow(/EXPO_ACCESS_TOKEN/);
  });

  test('with a token, returns a usable PushPort (positive control, T-17)', () => {
    const port = pushPortFromConfig({ ...baseConfig, expoAccessToken: 'tok-abc' });
    expect(typeof port.send).toBe('function');
    expect(typeof port.getReceipts).toBe('function');
  });
});

describe('expoFetchTransport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('POSTs JSON to the given url with the access token as a bearer credential', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify({ data: [{ status: 'ok', id: 'r1' }] }), { status: 200 }),
      );
    });

    const transport = expoFetchTransport('secret-token');
    const res = await transport(EXPO_SEND_URL, [{ to: 'ExponentPushToken[x]', data: {} }]);

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ status: 'ok', id: 'r1' }] });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(EXPO_SEND_URL);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer secret-token');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual([{ to: 'ExponentPushToken[x]', data: {} }]);
  });

  test('a non-2xx surfaces as ok:false (the sender treats it as retryable, never a silent success)', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('nope', { status: 401 })));
    const res = await expoFetchTransport('bad')(EXPO_SEND_URL, []);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
  });
});
