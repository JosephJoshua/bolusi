// ExpoPushSender: batching, the retry schedule, ticket-error handling, and receipts — all against a
// FAKE transport that records requests and scripts responses. NO real network, ever (CLAUDE.md §6):
// the only I/O seam is the injected `transport`, and `sleep` is a recording no-op so the ≤ 5-attempt
// backoff is asserted without wall-clock waiting.
import { describe, expect, test, vi } from 'vitest';

import { composeConflict, composeSync, type OutgoingPush } from './payload.js';
import {
  EXPO_RECEIPTS_URL,
  EXPO_SEND_URL,
  ExpoPushSender,
  RETRY_BACKOFF_MS,
  type PushHttpResponse,
  type PushTransport,
} from './expo-sender.js';

function okResponse(json: unknown): PushHttpResponse {
  return { ok: true, status: 200, json: () => Promise.resolve(json) };
}
function httpFail(status: number): PushHttpResponse {
  return { ok: false, status, json: () => Promise.resolve({}) };
}

/** A recording transport. `handler` decides each response (or throws for a network death). */
function makeTransport(handler: (url: string, body: unknown, call: number) => PushHttpResponse) {
  const calls: { url: string; body: unknown }[] = [];
  const transport: PushTransport = (url, body) => {
    const index = calls.length;
    calls.push({ url, body });
    return Promise.resolve(handler(url, body, index));
  };
  return { transport, calls };
}

function msg(seed: number): OutgoingPush {
  return {
    to: `ExponentPushToken[${seed}]`,
    deviceId: `device-${seed}`,
    push: composeSync(),
  };
}

function recordingSleep() {
  const waits: number[] = [];
  return { waits, sleep: (ms: number) => (waits.push(ms), Promise.resolve()) };
}

describe('batching (api/04-push §7: ≤ 100 per request)', () => {
  test('> 100 recipients split into ≤ 100-message batches, all sent once', async () => {
    const messages = Array.from({ length: 250 }, (_, i) => msg(i));
    const { transport, calls } = makeTransport((_url, body) => {
      const batch = body as unknown[];
      return okResponse({ data: batch.map((_, i) => ({ status: 'ok', id: `r-${i}` })) });
    });
    const sender = new ExpoPushSender({ transport });
    const tickets = await sender.send(messages);

    expect(calls).toHaveLength(3);
    expect((calls[0]!.body as unknown[]).length).toBe(100);
    expect((calls[1]!.body as unknown[]).length).toBe(100);
    expect((calls[2]!.body as unknown[]).length).toBe(50);
    // The WHOLE set (T-14): one ok ticket per input message, correlated by deviceId.
    expect(tickets).toHaveLength(250);
    expect(tickets.map((t) => t.deviceId)).toEqual(messages.map((m) => m.deviceId));
    expect(tickets.every((t) => t.status === 'ok')).toBe(true);
    expect(calls.every((c) => c.url === EXPO_SEND_URL)).toBe(true);
  });

  test('the wire message strips our internal deviceId; a visible push carries channelId', async () => {
    const conflict: OutgoingPush = {
      to: 'ExponentPushToken[c]',
      deviceId: 'device-c',
      push: composeConflict('018f4e2a-1111-7abc-8def-000000000001', 'id'),
    };
    const { transport, calls } = makeTransport(() =>
      okResponse({ data: [{ status: 'ok', id: 'r1' }] }),
    );
    await new ExpoPushSender({ transport }).send([conflict]);
    const sent = (calls[0]!.body as Record<string, unknown>[])[0]!;
    expect(sent).toHaveProperty('to', 'ExponentPushToken[c]');
    expect(sent).toHaveProperty('channelId', 'bolusi.conflict');
    expect(sent).not.toHaveProperty('deviceId');
  });
});

describe('retry schedule (api/01-sync §6: 5s→15s→60s→5min, max 5 attempts)', () => {
  test('a persistent request failure retries on the exact schedule, then drops the batch', async () => {
    const { transport, calls } = makeTransport(() => httpFail(503));
    const { waits, sleep } = recordingSleep();
    const sender = new ExpoPushSender({ transport, sleep });
    const tickets = await sender.send([msg(1), msg(2)]);

    expect(calls).toHaveLength(5); // MAX_SEND_ATTEMPTS
    expect(waits).toEqual([...RETRY_BACKOFF_MS]); // 5s, 15s, 60s, 300s between the 5 attempts
    // Dropped — never re-sent, never durable. Error tickets, but NOT DeviceNotRegistered (no delete).
    expect(tickets.every((t) => t.status === 'error' && t.error === 'RequestFailed')).toBe(true);
  });

  test('a network throw is retryable; success on a later attempt returns real tickets', async () => {
    const { transport, calls } = makeTransport((_url, _body, call) => {
      if (call < 2) throw new Error('ECONNRESET');
      return okResponse({ data: [{ status: 'ok', id: 'r-late' }] });
    });
    const { waits, sleep } = recordingSleep();
    const tickets = await new ExpoPushSender({ transport, sleep }).send([msg(1)]);

    expect(calls).toHaveLength(3);
    expect(waits).toEqual([RETRY_BACKOFF_MS[0], RETRY_BACKOFF_MS[1]]);
    expect(tickets[0]).toMatchObject({ status: 'ok', receiptId: 'r-late', deviceId: 'device-1' });
  });

  test('a 429 (rate-limited by Expo) is a retryable request failure', async () => {
    let attempts = 0;
    const { transport } = makeTransport(() => {
      attempts += 1;
      return attempts === 1 ? httpFail(429) : okResponse({ data: [{ status: 'ok', id: 'r' }] });
    });
    const { sleep } = recordingSleep();
    const tickets = await new ExpoPushSender({ transport, sleep }).send([msg(1)]);
    expect(attempts).toBe(2);
    expect(tickets[0]!.status).toBe('ok');
  });
});

describe('ticket errors (api/04-push §8)', () => {
  test('DeviceNotRegistered surfaces as an error ticket carrying that code', async () => {
    const { transport } = makeTransport(() =>
      okResponse({
        data: [
          { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } },
          { status: 'ok', id: 'r2' },
        ],
      }),
    );
    const tickets = await new ExpoPushSender({ transport }).send([msg(1), msg(2)]);
    expect(tickets[0]).toMatchObject({
      status: 'error',
      error: 'DeviceNotRegistered',
      deviceId: 'device-1',
    });
    expect(tickets[1]).toMatchObject({ status: 'ok', receiptId: 'r2' });
  });

  test('InvalidCredentials fires the alert hook and is logged, not thrown', async () => {
    const { transport } = makeTransport(() =>
      okResponse({ data: [{ status: 'error', details: { error: 'InvalidCredentials' } }] }),
    );
    const onInvalidCredentials = vi.fn();
    const logger = vi.fn();
    const tickets = await new ExpoPushSender({ transport, onInvalidCredentials, logger }).send([
      msg(7),
    ]);
    expect(onInvalidCredentials).toHaveBeenCalledWith({ deviceId: 'device-7' });
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'message_error', error: 'InvalidCredentials' }),
    );
    expect(tickets[0]!.status).toBe('error');
  });
});

describe('getReceipts (api/04-push §7/§8)', () => {
  test('POSTs { ids } to the receipts URL and maps ids to their status', async () => {
    const { transport, calls } = makeTransport((url) => {
      expect(url).toBe(EXPO_RECEIPTS_URL);
      return okResponse({
        data: {
          'r-ok': { status: 'ok' },
          'r-gone': { status: 'error', details: { error: 'DeviceNotRegistered' } },
        },
      });
    });
    const receipts = await new ExpoPushSender({ transport }).getReceipts(['r-ok', 'r-gone']);
    expect(calls[0]!.body).toEqual({ ids: ['r-ok', 'r-gone'] });
    expect(receipts.get('r-ok')).toEqual({ status: 'ok' });
    expect(receipts.get('r-gone')).toEqual({ status: 'error', error: 'DeviceNotRegistered' });
  });
});
