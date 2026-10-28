// @vitest-environment node
// The PC's side of the phone handoff against a stand-in server: what it sends, and how the
// server's answers reach the window.
import type { HandoffPageLabels, HandoffWireEvent } from '@bolusi/schemas';
import { describe, expect, it } from 'vitest';

import type { HandoffEvent } from '../src/core/api.js';
import { createHandoffClient } from '../src/core/handoff.js';

const LABELS = { take: 'Ambil foto' } as unknown as HandoffPageLabels;
const BASE = 'https://api.test';

/** A server that answers each call from a script, and records what it was asked. */
function server() {
  const calls: { method: string; path: string; body: unknown; auth: string | null }[] = [];
  const feed: (HandoffWireEvent[] | 'ended' | 'offline' | 'gone')[] = [];
  let release: (() => void) | null = null;
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const path = url.pathname.replace('/v1/handoff', '') + url.search;
    const method = init.method ?? 'GET';
    calls.push({
      method,
      path,
      body: init.body === undefined ? null : JSON.parse(init.body as string),
      auth: new Headers(init.headers).get('Authorization'),
    });
    if (method === 'POST' && path === '') {
      return Response.json({ id: 'p1', path: `/h/${'k'.repeat(32)}` });
    }
    if (path.startsWith('/gone')) return Response.json({}, { status: 404 });
    if (path.endsWith('/ask')) return Response.json({ seq: 7 });
    if (path.includes('/events')) {
      while (feed.length === 0) {
        if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        await new Promise<void>((resolve) => (release = resolve));
      }
      const next = feed.shift()!;
      if (next === 'offline') throw new TypeError('fetch failed');
      if (next === 'gone') return Response.json({}, { status: 404 });
      return Response.json(
        next === 'ended' ? { events: [], ended: true } : { events: next, ended: false },
      );
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const push = (item: (typeof feed)[number]): void => {
    feed.push(item);
    release?.();
  };
  return { calls, fetchImpl, push };
}

function client(token: string | null = 'bdt_pc') {
  const s = server();
  const events: HandoffEvent[] = [];
  const naps: number[] = [];
  const handoff = createHandoffClient({
    baseUrl: BASE,
    deviceToken: () => Promise.resolve(token),
    emit: (event) => events.push(event),
    fetchImpl: s.fetchImpl,
    sleep: (ms) => {
      naps.push(ms);
      return Promise.resolve();
    },
  });
  const settled = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return { ...s, events, naps, handoff, settled };
}

describe('the PC side of the phone handoff', () => {
  it('pairs with the device token and gives the phone page on the server', async () => {
    const { handoff, calls } = client();
    expect(await handoff.pair(LABELS)).toEqual({
      ok: true,
      id: 'p1',
      urls: [`${BASE}/h/${'k'.repeat(32)}`],
    });
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '',
      body: { labels: LABELS },
      auth: 'Bearer bdt_pc',
    });
    handoff.stop();
  });

  it('passes what the phone does to the window, asking only for what it has not seen', async () => {
    const { handoff, push, events, calls, settled } = client();
    await handoff.pair(LABELS);
    push([{ n: 1, type: 'paired' }]);
    await settled();
    push([
      { n: 2, type: 'photo', seq: 3, jpeg: Buffer.from([0xff, 0xd8, 0xff]).toString('base64') },
    ]);
    await settled();
    push([{ n: 3, type: 'signature', seq: 4, strokes: [[{ x: 1, y: 2 }]] }]);
    await settled();
    expect(events).toEqual([
      { id: 'p1', type: 'paired' },
      { id: 'p1', type: 'photo', seq: 3, bytes: new Uint8Array([0xff, 0xd8, 0xff]) },
      {
        id: 'p1',
        type: 'signature',
        seq: 4,
        strokes: [[{ x: 1, y: 2 }]],
        pad: { width: 800, height: 400 },
      },
    ]);
    expect(calls.filter((call) => call.path.includes('/events')).map((call) => call.path)).toEqual([
      '/p1/events?after=0',
      '/p1/events?after=1',
      '/p1/events?after=2',
      '/p1/events?after=3',
    ]);
    handoff.stop();
  });

  it('keeps listening through a dropped connection, and says so when the pairing ends', async () => {
    const { handoff, push, events, naps, settled } = client();
    await handoff.pair(LABELS);
    push('offline');
    push('offline');
    push([{ n: 1, type: 'paired' }]);
    await settled();
    expect(naps).toEqual([1_000, 2_000]);
    push('ended');
    await settled();
    expect(events).toEqual([
      { id: 'p1', type: 'paired' },
      { id: 'p1', type: 'expired' },
    ]);
  });

  it('asks for a step, and hears when the pairing is already over', async () => {
    const { handoff, calls } = client();
    expect(await handoff.ask('p1', 'photo', 'Depan')).toBe(7);
    expect(calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/p1/ask',
      body: { kind: 'photo', title: 'Depan' },
    });
    expect(await handoff.ask('gone', 'photo', 'Depan')).toBeNull();
  });

  it('withdraws and unpairs, and stops listening to an ended pairing', async () => {
    const { handoff, calls, push, events, settled } = client();
    await handoff.pair(LABELS);
    await handoff.withdraw('p1', 7);
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/p1/withdraw', body: { seq: 7 } });
    await handoff.unpair('p1');
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/p1' });
    push([{ n: 1, type: 'paired' }]);
    await settled();
    expect(events).toEqual([]);
  });

  it('says the PC is offline when it cannot reach the server or is not enrolled', async () => {
    const offline = createHandoffClient({
      baseUrl: BASE,
      deviceToken: () => Promise.resolve('bdt_pc'),
      emit: () => undefined,
      fetchImpl: (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch,
    });
    expect(await offline.pair(LABELS)).toEqual({ ok: false, problem: 'offline' });
    expect(await client(null).handoff.pair(LABELS)).toEqual({ ok: false, problem: 'offline' });
  });
});
