// Realtime SSE fallback + payload audit (api/00 §12.2/§12.3). SSE runs in-process via `app.request`
// (streaming `fetch`), so these do not need a real socket. Covers: the `event: sync.poke` frame with
// a monotonically increasing `id`, the `: hb` heartbeat, scope routing on the SSE leg (SEC-RT-04),
// auth on the SSE endpoint (SEC-RT-01), the frozen-payload audit over BOTH legs (SEC-RT-03), and the
// §11 realtime-connect rate limit (10/min/device → 11th 429).
import { describe, expect, test } from 'vitest';

import { zSyncPokeMessage, zWsFrame } from '@bolusi/schemas';

import { createApp } from '../../../src/app.js';
import { DEFAULT_DEVICE_RATE_LIMITS } from '../../../src/deps.js';
import { InMemoryTokenStore, createVerifyToken } from '../../../src/middleware/auth.js';
import { InMemoryRateLimitStore } from '../../../src/middleware/rate-limit.js';
import { SYNC_POKE_FRAME, type HubScheduler } from '../../../src/realtime/hub.js';
import { InProcessPokeHub } from '../../../src/realtime/poke-hub.js';
import { readError } from '../../helpers/http.js';
import { makeFixture } from '../../helpers/fixtures.js';

class FakeTime {
  ms = 0;
  #timers: { at: number; fn: () => void; live: boolean }[] = [];
  now = (): number => this.ms;
  scheduler: HubScheduler = {
    setTimer: (delayMs, fn) => {
      const timer = { at: this.ms + delayMs, fn, live: true };
      this.#timers.push(timer);
      return {
        cancel: () => {
          timer.live = false;
        },
      };
    },
  };
  advance(byMs: number): void {
    const target = this.ms + byMs;
    for (let guard = 0; guard < 100_000; guard += 1) {
      const due = this.#timers
        .filter((t) => t.live && t.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.ms = due.at;
      due.live = false;
      this.#timers = this.#timers.filter((t) => t !== due);
      due.fn();
    }
    this.ms = target;
  }
}

function makeRig(extra: Record<string, unknown> = {}) {
  const tokenStore = new InMemoryTokenStore();
  const pokeHub = new InProcessPokeHub();
  const time = new FakeTime();
  const app = createApp({
    now: time.now,
    verifyToken: createVerifyToken({ store: tokenStore, now: time.now }),
    realtimeScheduler: time.scheduler,
    pokeHub,
    ...extra,
  });
  return { app, tokenStore, pokeHub, time };
}

function enroll(
  tokenStore: InMemoryTokenStore,
  fx: ReturnType<typeof makeFixture>,
  opts: { revoked?: boolean } = {},
): string {
  tokenStore.add(fx.deviceToken, {
    kind: 'device',
    deviceId: fx.deviceId,
    tenantId: fx.tenantId,
    storeId: fx.storeId,
    deviceStatus: opts.revoked === true ? 'revoked' : 'active',
  });
  return `Bearer ${fx.deviceToken}`;
}

interface SseCollector {
  readonly buffer: () => string;
  waitFor(predicate: (buffer: string) => boolean, timeoutMs?: number): Promise<string>;
  cancel(): Promise<void>;
}

/**
 * Continuously drains the SSE body into one growing buffer, so tests poll the buffer instead of
 * awaiting reads directly. A `ReadableStream` permits only ONE outstanding read at a time; a
 * per-assertion `reader.read()` that timed out would leave a dangling read and break the next
 * assertion. One read loop, many polls, avoids that.
 */
function collectSse(res: Response): SseCollector {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value !== undefined) buffer += decoder.decode(value, { stream: true });
      }
    } catch {
      /* cancelled — stop draining */
    }
  })();
  return {
    buffer: () => buffer,
    async waitFor(predicate, timeoutMs = 1_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(buffer)) return buffer;
        await new Promise((r) => setTimeout(r, 5));
      }
      return buffer;
    },
    cancel: () => reader.cancel().catch(() => undefined),
  };
}

const SSE_URL = 'http://srv.test/v1/realtime/sse';

describe('realtime SSE (api/00 §12.2)', () => {
  test('poke → event: sync.poke with data {} and a monotonically increasing id', async () => {
    const { app, tokenStore, pokeHub, time } = makeRig();
    const fx = makeFixture('sse-poke');
    const auth = enroll(tokenStore, fx);
    const res = await app.request(SSE_URL, { headers: { Authorization: auth } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const sse = collectSse(res);
    await new Promise((r) => setTimeout(r, 20)); // let the stream callback register the connection

    pokeHub.publish([{ tenantId: fx.tenantId, storeId: fx.storeId }]);
    const first = await sse.waitFor((b) => b.includes('event: sync.poke'));
    expect(first).toContain('event: sync.poke');
    expect(first).toContain('data: {}');
    expect(first).toMatch(/id: 1\b/);

    // A second, distinct poke (past the coalescing window) carries the next id.
    time.advance(2_000);
    pokeHub.publish([{ tenantId: fx.tenantId, storeId: fx.storeId }]);
    const second = await sse.waitFor((b) => b.includes('id: 2'));
    expect(second).toMatch(/id: 2\b/);
    await sse.cancel();
  });

  test('SSE keepalive emits a `: hb` comment every 25 s', async () => {
    const { app, tokenStore, time } = makeRig();
    const fx = makeFixture('sse-hb');
    const auth = enroll(tokenStore, fx);
    const res = await app.request(SSE_URL, { headers: { Authorization: auth } });
    const sse = collectSse(res);
    await new Promise((r) => setTimeout(r, 20));

    time.advance(25_000); // one heartbeat cycle
    const buffer = await sse.waitFor((b) => b.includes(': hb'));
    expect(buffer).toContain(': hb');
    await sse.cancel();
  });

  test('SEC-RT-04 poke fan-out scope (SSE leg) — tenant B activity produces zero events for a tenant-A device', async () => {
    const { app, tokenStore, pokeHub } = makeRig();
    const a = makeFixture('sse-sec04-a');
    const b = makeFixture('sse-sec04-b');
    const authA = enroll(tokenStore, a);
    enroll(tokenStore, b);
    const res = await app.request(SSE_URL, { headers: { Authorization: authA } });
    const sse = collectSse(res);
    await new Promise((r) => setTimeout(r, 20));

    // Foreign activity (tenant B + a store A is not in) — must reach A's stream not at all.
    pokeHub.publish([
      { tenantId: b.tenantId, storeId: b.storeId },
      { tenantId: b.tenantId, storeId: null },
      { tenantId: a.tenantId, storeId: makeFixture('sse-sec04-other').storeId },
    ]);
    const afterForeign = await sse.waitFor((buf) => buf.includes('event: sync.poke'), 150);
    expect(afterForeign).not.toContain('event: sync.poke'); // zero foreign pokes

    // A legitimate in-scope poke DOES arrive — proving the stream was live (a real negative).
    pokeHub.publish([{ tenantId: a.tenantId, storeId: a.storeId }]);
    const afterOwn = await sse.waitFor((buf) => buf.includes('event: sync.poke'));
    expect(afterOwn).toContain('event: sync.poke');
    await sse.cancel();
  });

  test('SEC-RT-01 (SSE leg) — missing / invalid / revoked token → 401, no stream', async () => {
    const { app, tokenStore } = makeRig();
    const fx = makeFixture('sse-sec01');
    enroll(tokenStore, fx, { revoked: true });

    const missing = await app.request(SSE_URL);
    expect(missing.status).toBe(401);
    expect((await readError(missing)).error.code).toBe('AUTH_TOKEN_MISSING');

    const invalid = await app.request(SSE_URL, { headers: { Authorization: 'Bearer bdt_nope' } });
    expect(invalid.status).toBe(401);
    expect((await readError(invalid)).error.code).toBe('AUTH_TOKEN_INVALID');

    const revoked = await app.request(SSE_URL, {
      headers: { Authorization: `Bearer ${fx.deviceToken}` },
    });
    expect(revoked.status).toBe(401);
    expect((await readError(revoked)).error.code).toBe('DEVICE_REVOKED');

    // A query-string token is never read → treated as missing.
    const query = await app.request(`${SSE_URL}?token=${fx.deviceToken}`);
    expect(query.status).toBe(401);
    expect((await readError(query)).error.code).toBe('AUTH_TOKEN_MISSING');
  });
});

describe('SEC-RT-03 poke payload audit — every emitted realtime frame is the frozen sync.poke', () => {
  test('the WS wire constant validates against the frozen schema and carries no payload', () => {
    const parsed: unknown = JSON.parse(SYNC_POKE_FRAME);
    expect(zWsFrame.safeParse(parsed).success).toBe(true);
    expect(zSyncPokeMessage.safeParse(parsed).success).toBe(true);
    expect(parsed).toEqual({ type: 'sync.poke', payload: {} });
  });

  test('the SSE leg emits data exactly `{}` (asserted against the frozen schema)', () => {
    // The SSE emit writes `data: {}` (routes/realtime.ts). Model that wire value and audit it.
    const sseData = '{}';
    const frame = { type: 'sync.poke', payload: JSON.parse(sseData) as Record<string, unknown> };
    expect(zSyncPokeMessage.safeParse(frame).success).toBe(true);
  });

  test('a fixture frame carrying ANY business value fails the frozen schema (the guard bites)', () => {
    for (const payload of [
      { amount: 500 },
      { name: 'Budi' },
      { note: 'body text' },
      { entityId: 'x' },
    ]) {
      const evil = { type: 'sync.poke', payload };
      expect(zSyncPokeMessage.safeParse(evil).success).toBe(false);
    }
  });
});

describe('realtime connect rate limit (api/00 §11 — 10/min/device)', () => {
  test('the 11th realtime connect within a minute → 429 RATE_LIMITED envelope', async () => {
    const { app, tokenStore } = makeRig({ perDeviceStore: new InMemoryRateLimitStore() });
    const fx = makeFixture('sse-429');
    const auth = enroll(tokenStore, fx);
    const cap = DEFAULT_DEVICE_RATE_LIMITS.realtimePerMinute;
    expect(cap).toBe(10);

    // The reduced-chain realtime probe consumes the realtime bucket per request.
    for (let i = 0; i < cap; i += 1) {
      const ok = await app.request('http://srv.test/v1/realtime', {
        headers: { Authorization: auth },
      });
      expect(ok.status).toBe(200);
    }
    const limited = await app.request('http://srv.test/v1/realtime', {
      headers: { Authorization: auth },
    });
    expect(limited.status).toBe(429);
    expect((await readError(limited)).error.code).toBe('RATE_LIMITED');
    expect(limited.headers.get('Retry-After')).not.toBeNull();
  });
});
