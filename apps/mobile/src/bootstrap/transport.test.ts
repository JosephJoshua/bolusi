// The fetch `SyncTransportPort` (api/01-sync §3/§4) — the HTTP↔port translation layer.
//
// The one behaviour worth most of this file: the adapter discriminates on the api/00 §7 envelope's
// `error.code`, NEVER on the status. `syncDisabled` has no automatic exit (03 §10), so reading a
// 401 as "revoked" would permanently disable sync on a device whose token merely expired — a
// re-enrollment to recover from a refresh. `fetch` is injected; no socket is opened (T-6/T-7).
import { SyncTransportError } from '@bolusi/core';
import type { PullRequest, PushRequest } from '@bolusi/schemas';
import { describe, expect, test, vi } from 'vitest';

import { createFetchSyncTransport } from './transport.js';

const PUSH: PushRequest = { deviceId: 'device-1', ops: [] };
// api/01 §4's real shape: no deviceId (the token identifies the device), and
// `devicesDirectoryVersion` 0 = no directory held. Typed, not cast — a cast here would have
// hidden that this DTO is not the shape I assumed.
const PULL: PullRequest = { cursor: 0, limit: 100, devicesDirectoryVersion: 0 };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function transport(fetchImpl: typeof fetch, token: string | null = 'bdt_secret') {
  return createFetchSyncTransport({
    baseUrl: 'https://api.example.com',
    deviceToken: () => Promise.resolve(token),
    fetchImpl,
  });
}

describe('the wire (api/01-sync §3/§4)', () => {
  test('push POSTs the DTO to /v1/sync/push with the device token', async () => {
    const doFetch = vi.fn(async () => jsonResponse(200, { results: [], serverTime: 1 }));
    const result = await transport(doFetch as unknown as typeof fetch).push(PUSH);

    expect(doFetch).toHaveBeenCalledTimes(1);
    const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/sync/push');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer bdt_secret');
    expect(JSON.parse(init.body as string)).toStrictEqual(PUSH);
    expect(result).toStrictEqual({ results: [], serverTime: 1 });
  });

  test('pull POSTs to /v1/sync/pull and returns the parsed DTO', async () => {
    const body = { ops: [], hasMore: false, cursor: 0, serverTime: 2 };
    const doFetch = vi.fn(async () => jsonResponse(200, body));

    await expect(transport(doFetch as unknown as typeof fetch).pull(PULL)).resolves.toStrictEqual(
      body,
    );
    expect((doFetch.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://api.example.com/v1/sync/pull',
    );
  });

  test('the token is read PER CALL, never cached — a wiped token stops being sent', async () => {
    // api/02-auth §7.3's crypto-erase deletes the token. An adapter that cached it at construction
    // would keep authenticating a revoked device until the process restarted.
    let token: string | null = 'bdt_first';
    const doFetch = vi.fn(async () => jsonResponse(200, { results: [], serverTime: 1 }));
    const port = createFetchSyncTransport({
      baseUrl: 'https://api.example.com',
      deviceToken: () => Promise.resolve(token),
      fetchImpl: doFetch as unknown as typeof fetch,
    });

    await port.push(PUSH);
    token = 'bdt_second';
    await port.push(PUSH);

    const auth = doFetch.mock.calls.map(
      (c) =>
        ((c as unknown as [string, RequestInit])[1].headers as Record<string, string>)[
          'Authorization'
        ],
    );
    expect(auth).toStrictEqual(['Bearer bdt_first', 'Bearer bdt_second']);
  });
});

describe('failures speak the envelope`s code, never the status (api/01-sync §2; 03 §10)', () => {
  test('401 DEVICE_REVOKED carries the code through verbatim', async () => {
    const doFetch = vi.fn(async () =>
      jsonResponse(401, { error: { code: 'DEVICE_REVOKED', message: 'device revoked' } }),
    );

    await expect(transport(doFetch as unknown as typeof fetch).push(PUSH)).rejects.toMatchObject({
      code: 'DEVICE_REVOKED',
      status: 401,
    });
  });

  test('401 AUTH_TOKEN_INVALID is NOT a revocation — the same status, a different code', async () => {
    // THE TEST THIS FILE EXISTS FOR. Both are 401s. An adapter keyed on the status would collapse
    // them, and the loop would set `syncDisabled` — which has no automatic exit (03 §10) — bricking
    // a working device on an expired token.
    const doFetch = vi.fn(async () =>
      jsonResponse(401, { error: { code: 'AUTH_TOKEN_INVALID', message: 'expired' } }),
    );

    const error = await transport(doFetch as unknown as typeof fetch)
      .push(PUSH)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SyncTransportError);
    expect((error as SyncTransportError).code).toBe('AUTH_TOKEN_INVALID');
    expect((error as SyncTransportError).code).not.toBe('DEVICE_REVOKED');
  });

  test('a non-JSON body (proxy/captive portal) yields code null — a network-class failure', async () => {
    // A shop's captive portal answering a sync POST with HTML must not throw a parse error out of
    // the adapter, and must not look like any known code. `null` ⇒ backoff, which is correct.
    const doFetch = vi.fn(async () => new Response('<html>Login to WiFi</html>', { status: 502 }));

    await expect(transport(doFetch as unknown as typeof fetch).pull(PULL)).rejects.toMatchObject({
      code: null,
      status: 502,
    });
  });

  test('no device token ⇒ AUTH_TOKEN_MISSING, and NOTHING is sent', async () => {
    // Fail closed. An anonymous POST would earn a 401 that costs a backoff cycle for a fault we
    // could see locally.
    const doFetch = vi.fn(async () => jsonResponse(200, {}));

    await expect(
      transport(doFetch as unknown as typeof fetch, null).push(PUSH),
    ).rejects.toMatchObject({ code: 'AUTH_TOKEN_MISSING', status: null });
    expect(doFetch).not.toHaveBeenCalled();
  });

  test('a rejected op inside a 200 is NOT a transport failure (03 §10)', async () => {
    // "an op-level rejected result is not a loop failure" — it resolves. If this threw, one bad op
    // would put the whole device into backoff and the rejection would never reach the UI.
    const body = {
      results: [{ id: 'op-1', status: 'rejected', code: 'SCOPE_VIOLATION', reason: 'nope' }],
      serverTime: 3,
    };
    const doFetch = vi.fn(async () => jsonResponse(200, body));

    await expect(transport(doFetch as unknown as typeof fetch).push(PUSH)).resolves.toStrictEqual(
      body,
    );
  });
});
