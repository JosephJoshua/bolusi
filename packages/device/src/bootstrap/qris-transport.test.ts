// The QRIS fetch adapter: the wire the server's QRIS routes expect, made as the signed-in person on
// the device bearer, and the closed failure set the screens explain. `fetch` is injected.
import { QrisError, qrisFailure } from '@bolusi/modules/money';
import { describe, expect, test, vi } from 'vitest';

import { QRIS_CALL_TIMEOUT_MS, createFetchQris } from './qris-transport.js';

const CHARGE = {
  id: '01920000-0000-7000-8000-0000000000c1',
  status: 'waiting',
  amount: 150_000,
  qrString: '000201...',
  environment: 'test',
  expiresAt: 1_900_000_000_000,
  paidAt: null,
};
const ACCOUNT = '01920000-0000-7000-8000-00000000a001';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function qris(fetchImpl: typeof fetch, token: string | null = 'bdt_secret') {
  return createFetchQris({
    baseUrl: 'https://api.example.com',
    deviceToken: () => Promise.resolve(token),
    fetchImpl,
  })('u-cashier');
}

function sent(doFetch: ReturnType<typeof vi.fn>) {
  const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
  return {
    url,
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: init.body === undefined ? undefined : (JSON.parse(init.body as string) as unknown),
  };
}

async function failure(call: Promise<unknown>): Promise<string> {
  const error = await call.then(
    () => new Error('expected a failure'),
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(QrisError);
  return qrisFailure(error);
}

describe('the QRIS wire', () => {
  test('a QR is asked for as the person signed in, on the device bearer', async () => {
    const doFetch = vi.fn(async () => jsonResponse(200, CHARGE));
    const body = {
      id: CHARGE.id,
      accountId: ACCOUNT,
      document: { kind: 'repair.ticket', id: '01920000-0000-7000-8000-0000000000d1', label: 'K-1' },
      amount: 150_000,
    };
    await expect(qris(doFetch as unknown as typeof fetch).createCharge(body)).resolves.toEqual(
      CHARGE,
    );
    expect(sent(doFetch)).toEqual({
      url: 'https://api.example.com/v1/money/qris/charges',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer bdt_secret',
        'X-Acting-User': 'u-cashier',
      },
      body,
    });
  });

  test('each call goes to its route', async () => {
    const connection = { accountId: ACCOUNT, environment: 'live', connectedAt: 1 };
    const cases: [
      string,
      (port: ReturnType<typeof qris>) => Promise<unknown>,
      unknown,
      string,
      string,
    ][] = [
      ['connections', (p) => p.connections(), { connections: [connection] }, 'GET', '/accounts'],
      [
        'connect',
        (p) => p.connect(ACCOUNT, 'xnd_production_abcdefghijklmnop'),
        connection,
        'PUT',
        `/accounts/${ACCOUNT}`,
      ],
      ['charge', (p) => p.charge(CHARGE.id), CHARGE, 'GET', `/charges/${CHARGE.id}`],
      ['simulate', (p) => p.simulate(CHARGE.id), CHARGE, 'POST', `/charges/${CHARGE.id}/simulate`],
    ];
    for (const [, call, answer, method, path] of cases) {
      const doFetch = vi.fn(async () => jsonResponse(200, answer));
      await call(qris(doFetch as unknown as typeof fetch));
      const request = sent(doFetch);
      expect(request.method).toBe(method);
      expect(request.url).toBe(`https://api.example.com/v1/money/qris${path}`);
    }
    const remove = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(
      qris(remove as unknown as typeof fetch).disconnect(ACCOUNT),
    ).resolves.toBeUndefined();
    expect(sent(remove).method).toBe('DELETE');
  });

  test('the server answers become what the counter can act on', async () => {
    const answer = (status: number, code?: string) =>
      vi.fn(async () =>
        jsonResponse(status, code === undefined ? {} : { error: { code, message: 'x' } }),
      ) as unknown as typeof fetch;
    const cases: [number, string | undefined, string][] = [
      [409, 'QRIS_NOT_CONNECTED', 'notConnected'],
      [422, 'QRIS_KEY_REFUSED', 'keyRefused'],
      [422, 'QRIS_AMOUNT_REFUSED', 'amountRefused'],
      [503, 'QRIS_UNAVAILABLE', 'unavailable'],
      [409, 'CHANGE_REFUSED', 'refused'],
      [403, 'PERMISSION_DENIED', 'denied'],
      [404, 'NOT_FOUND', 'notFound'],
      [502, undefined, 'offline'],
      [409, 'IDEMPOTENCY_CONFLICT', 'unexpected'],
      [500, undefined, 'unexpected'],
    ];
    for (const [status, code, expected] of cases) {
      expect(await failure(qris(answer(status, code)).charge(CHARGE.id))).toBe(expected);
    }
  });

  test('a call with no answer in time is given up as offline', async () => {
    vi.useFakeTimers();
    try {
      const hanging = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ) as unknown as typeof fetch;
      const call = failure(qris(hanging).charge(CHARGE.id));
      await vi.advanceTimersByTimeAsync(QRIS_CALL_TIMEOUT_MS);
      expect(await call).toBe('offline');
    } finally {
      vi.useRealTimers();
    }
  });

  test('no answer is offline; a garbled one or no token is unexpected', async () => {
    const offline = vi.fn(async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    expect(await failure(qris(offline).connections())).toBe('offline');

    const garbled = vi.fn(async () => jsonResponse(200, { status: 'paid' }));
    expect(await failure(qris(garbled as unknown as typeof fetch).charge(CHARGE.id))).toBe(
      'unexpected',
    );

    const never = vi.fn();
    expect(await failure(qris(never as unknown as typeof fetch, null).connections())).toBe(
      'unexpected',
    );
    expect(never).not.toHaveBeenCalled();
  });
});
