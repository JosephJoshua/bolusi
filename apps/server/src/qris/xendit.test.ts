// The Xendit client against a recorded fetch: what it sends, and how it reads Xendit's answers.
import { describe, expect, test } from 'vitest';

import { createXenditClient, XenditRefusal, XenditUnavailable } from './xendit.js';

const KEY = 'xnd_development_abc';

function recorder(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as unknown as typeof fetch;
  return { calls, client: createXenditClient({ baseUrl: 'https://x.test', fetchImpl }) };
}

describe('the Xendit client', () => {
  test('makes a dynamic IDR QR with the key as Basic auth and the QR API version', async () => {
    const { calls, client } = recorder(200, { id: 'qr_1', qr_string: '000201...' });
    const qr = await client.createDynamicQr(KEY, {
      referenceId: 'ref-1',
      amount: 150_000,
      expiresAt: Date.UTC(2026, 9, 28, 10, 0, 0),
    });
    expect(qr).toEqual({ qrId: 'qr_1', qrString: '000201...' });
    const [call] = calls;
    expect(call?.url).toBe('https://x.test/qr_codes');
    expect(call?.init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from(`${KEY}:`).toString('base64')}`,
      'api-version': '2022-07-31',
    });
    expect(JSON.parse(String(call?.init.body))).toEqual({
      reference_id: 'ref-1',
      type: 'DYNAMIC',
      currency: 'IDR',
      amount: 150_000,
      expires_at: '2026-10-28T10:00:00.000Z',
    });
  });

  test('points the QR webhook here and keeps the token Xendit returns', async () => {
    const { calls, client } = recorder(200, { callback_token: 'tok', environment: 'TEST' });
    expect(await client.setQrWebhook(KEY, 'https://api/x')).toEqual({
      callbackToken: 'tok',
      environment: 'test',
    });
    expect(calls[0]?.url).toBe('https://x.test/callback_urls/qr_code');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ url: 'https://api/x' });
  });

  test('reads a QR payments list, keeping only what it understands', async () => {
    const { client } = recorder(200, {
      data: [
        { id: 'qrpy_1', amount: 150_000, status: 'SUCCEEDED' },
        { id: 'qrpy_2', amount: 10, status: 'REFUNDED' },
        { nonsense: true },
      ],
    });
    expect(await client.listQrPayments(KEY, 'qr_1')).toEqual([
      { paymentId: 'qrpy_1', amount: 150_000, succeeded: true },
      { paymentId: 'qrpy_2', amount: 10, succeeded: false },
    ]);
  });

  test.each([
    [401, { error_code: 'INVALID_API_KEY' }, 'keyInvalid'],
    [403, { error_code: 'REQUEST_FORBIDDEN_ERROR' }, 'keyNotAllowed'],
    [400, { error_code: 'API_VALIDATION_ERROR' }, 'amountNotAllowed'],
  ])('a %i refusal is a reason the person can act on', async (status, body, reason) => {
    const { client } = recorder(status, body);
    const made = client.createDynamicQr(KEY, { referenceId: 'r', amount: 1, expiresAt: 0 });
    await expect(made).rejects.toEqual(new XenditRefusal(reason as 'keyInvalid'));
  });

  test('anything else is Xendit being unavailable', async () => {
    const { client } = recorder(502, { error_code: 'SERVER_ERROR' });
    await expect(client.listQrPayments(KEY, 'qr_1')).rejects.toBeInstanceOf(XenditUnavailable);
    const offline = createXenditClient({
      fetchImpl: (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch,
    });
    await expect(offline.listQrPayments(KEY, 'qr_1')).rejects.toBeInstanceOf(XenditUnavailable);
  });
});
