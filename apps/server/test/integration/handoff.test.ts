// The phone handoff over the real middleware chain: a counter PC pairs, asks for steps and collects
// what the phone sends; the phone gets its page, waits for steps and sends. Time is virtual, so the
// long waits and the idle expiry are driven, never slept on.
import type { HandoffEventsResponse, HandoffPageLabels } from '@bolusi/schemas';
import { describe, expect, test } from 'vitest';

import { HandoffRelay, HANDOFF_IDLE_MS, HANDOFF_POLL_MS } from '../../src/handoff/relay.js';
import type { HubScheduler } from '../../src/realtime/hub.js';
import { enrollDevice, makeTestApp } from '../helpers/app.js';
import { readError } from '../helpers/http.js';

const ORIGIN = 'http://srv.test';
/** Lets a request reach the point where it waits. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const API = `${ORIGIN}/v1/handoff`;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const LABELS: HandoffPageLabels = {
  photoHint: 'Ambil foto, lalu kirim ke komputer.',
  signatureHint: 'Minta pelanggan tanda tangan <b>',
  take: 'Ambil foto',
  retake: 'Ulangi',
  clear: 'Hapus',
  send: 'Kirim ke komputer',
  sending: 'Mengirim…',
  sent: 'Terkirim.',
  waiting: 'Menunggu.',
  rotate: 'Putar HP.',
  rotateNow: 'Putar layar',
  failed: 'Belum terkirim.',
  withdrawn: 'Dibatalkan.',
  expired: 'Kedaluwarsa </script><script>alert(1)</script>',
  unreadable: 'Tidak bisa dibaca.',
};

/** Virtual time: `advance` fires the timers that fall due, in order. */
class FakeTime {
  ms = 0;
  #timers: { at: number; fn: () => void; live: boolean }[] = [];
  scheduler: HubScheduler = {
    setTimer: (delayMs, fn) => {
      const timer = { at: this.ms + delayMs, fn, live: true };
      this.#timers.push(timer);
      return { cancel: () => void (timer.live = false) };
    },
  };
  advance(byMs: number): void {
    const target = this.ms + byMs;
    for (;;) {
      const due = this.#timers
        .filter((t) => t.live && t.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.ms = due.at;
      due.live = false;
      due.fn();
    }
    this.ms = target;
  }
}

const PC = {
  deviceId: '0190f000-0000-7000-8000-000000000001',
  tenantId: '0190f000-0000-7000-8000-0000000000aa',
  storeId: '0190f000-0000-7000-8000-0000000000bb',
  token: 'bdt_handoff0001',
};
const OTHER_PC = {
  ...PC,
  deviceId: '0190f000-0000-7000-8000-000000000002',
  token: 'bdt_handoff0002',
};

function harness() {
  const time = new FakeTime();
  const h = makeTestApp({ handoffRelay: new HandoffRelay(time.scheduler) });
  const auth = enrollDevice(h, PC);
  const call = (path: string, init: RequestInit = {}, as = auth) =>
    h.app.request(`${API}${path}`, {
      ...init,
      headers: { Authorization: as, 'Content-Type': 'application/json', ...init.headers },
    });
  const pair = async (as = auth): Promise<{ id: string; page: string }> => {
    const res = await call('', { method: 'POST', body: JSON.stringify({ labels: LABELS }) }, as);
    expect(res.status).toBe(200);
    const { id, path } = (await res.json()) as { id: string; path: string };
    expect(path).toMatch(/^\/h\/[A-Za-z0-9_-]{32}$/);
    return { id, page: `${ORIGIN}${path}` };
  };
  const ask = async (id: string, kind: string, title: string): Promise<number> => {
    const res = await call(`/${id}/ask`, { method: 'POST', body: JSON.stringify({ kind, title }) });
    expect(res.status).toBe(200);
    return ((await res.json()) as { seq: number }).seq;
  };
  const events = async (id: string, after: number, as = auth): Promise<HandoffEventsResponse> => {
    const res = await call(`/${id}/events?after=${String(after)}`, {}, as);
    expect(res.status).toBe(200);
    return (await res.json()) as HandoffEventsResponse;
  };
  /** The pairing is not (or no longer) this PC's: the same 404 whichever it is. */
  const gone = async (id: string, as = auth): Promise<boolean> => {
    const res = await call(`/${id}/events?after=0`, {}, as);
    return res.status === 404 && (await readError(res)).error.code === 'NOT_FOUND';
  };
  const next = async (
    page: string,
    v: number,
  ): Promise<{ status: number; body: { v: number; ask: { seq: number } | null } }> => {
    const res = await h.app.request(`${page}/next?v=${String(v)}`);
    return {
      status: res.status,
      body: res.status === 200 ? ((await res.json()) as never) : { v: -1, ask: null },
    };
  };
  const send = (page: string, seq: number, body: Uint8Array<ArrayBuffer> | string) =>
    h.app.request(`${page}/send?seq=${String(seq)}`, { method: 'POST', body });
  return { h, time, auth, call, pair, ask, events, gone, next, send };
}

describe('the phone page', () => {
  test('is served by its key, with its copy escaped and scripts locked down; the PC hears it opened', async () => {
    const { h, time, pair, events } = harness();
    const { id, page } = await pair();
    const res = await h.app.request(page);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('Minta pelanggan tanda tangan &#60;b&#62;');
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('capture="environment"');
    expect(html).not.toMatch(/ style="/);
    expect(await events(id, 0)).toEqual({ events: [{ n: 1, type: 'paired' }], ended: false });
    // A reload does not pair twice: there is no news for the PC.
    await h.app.request(page);
    const later = events(id, 1);
    await settle();
    time.advance(HANDOFF_POLL_MS);
    expect(await later).toEqual({ events: [], ended: false });
  });

  test('a wrong or ended key gets 410, and the key never reaches the access log', async () => {
    const { h, pair, call } = harness();
    const { id, page } = await pair();
    expect((await h.app.request(page.replace(/[^/]+$/, 'A'.repeat(32)))).status).toBe(410);
    expect((await h.app.request(`${ORIGIN}/h/short`)).status).toBe(410);
    await h.app.request(page);
    expect((await call(`/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await h.app.request(page)).status).toBe(410);
    const key = page.split('/h/')[1]!;
    expect(h.accessLogs.some((log) => log.path.includes(key))).toBe(false);
    expect(h.accessLogs.some((log) => log.path === '/h/:key')).toBe(true);
  });
});

describe('one pairing for every step', () => {
  test('each step reaches the phone and what it sends reaches the PC, without a new code', async () => {
    const { h, pair, ask, events, next, send } = harness();
    const { id, page } = await pair();
    await h.app.request(page);
    expect(await next(page, -1)).toEqual({ status: 200, body: { v: 0, ask: null } });

    // The phone waits; the PC asks for a photo and the wait ends with it.
    const waiting = next(page, 0);
    const front = await ask(id, 'photo', 'Depan');
    expect(await waiting).toEqual({
      status: 200,
      body: { v: 1, ask: { seq: front, kind: 'photo', title: 'Depan' } },
    });
    // The PC is waiting too; the phone's photo ends that wait.
    const collecting = events(id, 1);
    expect((await send(page, front, JPEG)).status).toBe(204);
    expect(await collecting).toEqual({
      events: [{ n: 2, type: 'photo', seq: front, jpeg: Buffer.from(JPEG).toString('base64') }],
      ended: false,
    });
    expect((await next(page, 1)).body).toEqual({ v: 2, ask: null });

    const sign = await ask(id, 'signature', 'Tanda tangan');
    expect((await next(page, 2)).body.ask).toEqual({
      seq: sign,
      kind: 'signature',
      title: 'Tanda tangan',
    });
    const strokes = [
      [
        { x: 10, y: 20 },
        { x: 900, y: -5 },
      ],
    ];
    expect((await send(page, sign, JSON.stringify({ strokes }))).status).toBe(204);
    expect((await events(id, 2)).events).toEqual([
      {
        n: 3,
        type: 'signature',
        seq: sign,
        strokes: [
          [
            { x: 10, y: 20 },
            { x: 800, y: 0 },
          ],
        ],
      },
    ]);
  });

  test('refuses a send for a step the PC backed out of or replaced', async () => {
    const { pair, ask, call, next, send, events } = harness();
    const { id, page } = await pair();
    const first = await ask(id, 'photo', 'Depan');
    await call(`/${id}/withdraw`, { method: 'POST', body: JSON.stringify({ seq: first }) });
    expect((await next(page, 1)).body.ask).toBeNull();
    expect((await send(page, first, JPEG)).status).toBe(409);
    const second = await ask(id, 'photo', 'Belakang');
    const third = await ask(id, 'photo', 'Atas');
    expect((await send(page, second, JPEG)).status).toBe(409);
    expect((await send(page, third, JPEG)).status).toBe(204);
    expect((await events(id, 0)).events.map((event) => event.type)).toEqual(['photo']);
  });

  test('refuses what is not a photo, a bad signature, and one past the size limit', async () => {
    const { pair, ask, next, send } = harness();
    const { id, page } = await pair();
    const photo = await ask(id, 'photo', 'Depan');
    expect((await send(page, photo, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).status).toBe(415);
    expect((await send(page, photo, new Uint8Array(5 * 1024 * 1024).fill(0xff))).status).toBe(413);
    const sign = await ask(id, 'signature', 'Tanda tangan');
    for (const body of ['nope', '{"strokes":[]}', '{"strokes":[[{"x":"1","y":2}]]}']) {
      expect((await send(page, sign, body)).status, body).toBe(400);
    }
    // None of that spent the step.
    expect((await next(page, 0)).body.ask?.seq).toBe(sign);
  });
});

describe('the pairing', () => {
  test('belongs to the PC that made it', async () => {
    const { h, pair, ask, call, gone } = harness();
    const other = enrollDevice(h, OTHER_PC);
    const { id } = await pair();
    const res = await call(
      `/${id}/ask`,
      {
        method: 'POST',
        body: JSON.stringify({ kind: 'photo', title: 'Depan' }),
      },
      other,
    );
    expect(res.status).toBe(404);
    expect((await readError(res)).error.code).toBe('NOT_FOUND');
    expect(await gone(id, other)).toBe(true);
    expect((await call(`/${id}`, { method: 'DELETE' }, other)).status).toBe(404);
    await ask(id, 'photo', 'Depan'); // still the first PC's
  });

  test('a new code ends the old one, and a waiting phone and PC hear it', async () => {
    const { h, pair, events, next } = harness();
    const first = await pair();
    const phone = next(first.page, 0);
    const pc = events(first.id, 0);
    const second = await pair();
    expect((await phone).status).toBe(410);
    expect(await pc).toEqual({ events: [], ended: true });
    expect((await h.app.request(first.page)).status).toBe(410);
    expect((await h.app.request(second.page)).status).toBe(200);
  });

  test('ends after half an hour with no step, and a wait with no news is answered empty', async () => {
    const { time, pair, ask, events, gone, next } = harness();
    const { id, page } = await pair();
    const quiet = events(id, 0);
    await settle();
    time.advance(HANDOFF_POLL_MS);
    expect(await quiet).toEqual({ events: [], ended: false });
    await ask(id, 'photo', 'Depan');
    time.advance(HANDOFF_IDLE_MS - 1);
    expect((await next(page, 0)).status).toBe(200);
    time.advance(1);
    expect((await next(page, 0)).status).toBe(410);
    expect(await gone(id)).toBe(true);
  });

  test('takes only well-formed asks', async () => {
    const { pair, call } = harness();
    const { id } = await pair();
    for (const body of [
      { kind: 'video', title: 'x' },
      { kind: 'photo', title: 'x'.repeat(301) },
      {},
    ]) {
      const res = await call(`/${id}/ask`, { method: 'POST', body: JSON.stringify(body) });
      expect(res.status).toBe(422);
    }
    const res = await call('', { method: 'POST', body: JSON.stringify({ labels: { take: 'x' } }) });
    expect(res.status).toBe(422);
  });

  test('needs an enrolled device', async () => {
    const { h } = harness();
    const res = await h.app.request(API, {
      method: 'POST',
      body: JSON.stringify({ labels: LABELS }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(401);
  });
});
