// The `POST /v1/users/:userId/pin-verifier` fetch adapter (api/02-auth §5.4; task 186a-2). `fetch` is
// injected; no socket is opened (T-6/T-7). Asserts the wire the server's `PutPinVerifierReq` expects
// and the failure contract the pending-verifier queue relies on.
import type { PinVerifier } from '@bolusi/core';
import { describe, expect, test, vi } from 'vitest';

import { createFetchPinVerifierUpload } from './pin-verifier-transport.js';

const VERIFIER: PinVerifier = {
  algorithm: 'argon2id',
  saltB64: 'c2FsdHNhbHRzYWx0c2E=',
  mKiB: 19456,
  t: 2,
  p: 1,
  hashB64: 'aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA==',
  asOf: { timestamp: 1_726_000_000_000, deviceId: 'device-1', seq: 7 },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function port(fetchImpl: typeof fetch, token: string | null = 'bdt_secret') {
  return createFetchPinVerifierUpload({
    baseUrl: 'https://api.example.com',
    deviceToken: () => Promise.resolve(token),
    fetchImpl,
  });
}

describe('the pin-verifier wire (api/02-auth §5.4)', () => {
  test('POSTs { verifierRef, verifier } to /v1/users/:id/pin-verifier with the device bearer + X-Acting-User', async () => {
    const doFetch = vi.fn(async () => jsonResponse(200, { userId: 'user-a', applied: true }));
    const result = await port(doFetch as unknown as typeof fetch).upload(
      'user-a',
      'ref-1',
      VERIFIER,
    );

    expect(doFetch).toHaveBeenCalledTimes(1);
    const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/users/user-a/pin-verifier');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer bdt_secret');
    // Self-change: the acting user IS the target (§6.6), so no permission is needed server-side.
    expect(headers['X-Acting-User']).toBe('user-a');
    expect(JSON.parse(init.body as string)).toStrictEqual({
      verifierRef: 'ref-1',
      verifier: VERIFIER,
    });
    expect(result).toStrictEqual({ userId: 'user-a', applied: true });
  });

  test('a 200 with applied:false is returned (the §5.3 stale-POST answer — terminal, not an error)', async () => {
    const doFetch = vi.fn(async () => jsonResponse(200, { userId: 'user-a', applied: false }));
    const result = await port(doFetch as unknown as typeof fetch).upload(
      'user-a',
      'ref-1',
      VERIFIER,
    );
    // Returned (not thrown) so the queue treats it as terminal and drops the item.
    expect(result.applied).toBe(false);
  });

  test('a non-2xx THROWS so the queue keeps the item for the next online contact', async () => {
    const doFetch = vi.fn(async () => jsonResponse(503, { error: { code: 'UNAVAILABLE' } }));
    await expect(
      port(doFetch as unknown as typeof fetch).upload('user-a', 'ref-1', VERIFIER),
    ).rejects.toThrow(/HTTP 503/);
  });

  test('a missing device token fails closed (throws) rather than POSTing anonymously', async () => {
    const doFetch = vi.fn(async () => jsonResponse(200, { userId: 'user-a', applied: true }));
    await expect(
      port(doFetch as unknown as typeof fetch, null).upload('user-a', 'ref-1', VERIFIER),
    ).rejects.toThrow(/device token/);
    expect(doFetch).not.toHaveBeenCalled();
  });
});
