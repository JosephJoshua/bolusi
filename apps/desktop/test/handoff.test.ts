// @vitest-environment node
// The phone handoff's page server, over real HTTP on this machine: what a paired phone gets and may
// send, and what reaches the counter window. A stand-in for the window records the events.
import type { WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HandoffEvent, HandoffPageLabels } from '../src/main/bridge.js';
import { HandoffServer, lanAddresses, strokesOf } from '../src/main/handoff.js';

vi.mock('electron', () => ({ ipcMain: {} }));

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
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

let server: HandoffServer;
afterEach(() => server.unpair());

function window(): { contents: WebContents; events: HandoffEvent[] } {
  const events: HandoffEvent[] = [];
  const contents = {
    isDestroyed: () => false,
    send: (_channel: string, event: HandoffEvent) => events.push(event),
    once: () => undefined,
    off: () => undefined,
  } as unknown as WebContents;
  return { contents, events };
}

async function paired(): Promise<{ url: string; id: string; events: HandoffEvent[] }> {
  server = new HandoffServer(() => ['127.0.0.1']);
  const { contents, events } = window();
  const opened = await server.pair(contents, LABELS);
  if (!opened.ok) throw new Error(opened.problem);
  return { url: opened.urls[0]!, id: opened.id, events };
}

const next = async (url: string, v: number): Promise<{ v: number; ask: unknown }> =>
  (await (await fetch(`${url}/next?v=${String(v)}`)).json()) as { v: number; ask: unknown };

describe('phone handoff', () => {
  it('serves the page when the code is scanned, with its copy escaped and scripts locked down', async () => {
    const { url, id, events } = await paired();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/h\/[A-Za-z0-9_-]{32}$/);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const html = await response.text();
    expect(html).toContain('Minta pelanggan tanda tangan &#60;b&#62;');
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('capture="environment"');
    expect(html).not.toMatch(/ style="/);
    expect(events).toEqual([{ id, type: 'paired' }]);
    // Opening it again (a reload) does not pair twice.
    await fetch(url);
    expect(events).toHaveLength(1);
  });

  it('puts each step in front of the paired phone and takes what it sends, one scan for all', async () => {
    const { url, id, events } = await paired();
    expect(await next(url, -1)).toEqual({ v: 0, ask: null });

    // The phone waits; the counter asks for a photo and the wait ends with it.
    const waiting = next(url, 0);
    const front = server.ask(id, 'photo', 'Depan');
    expect(await waiting).toEqual({ v: 1, ask: { seq: front, kind: 'photo', title: 'Depan' } });
    expect(
      (await fetch(`${url}/send?seq=${String(front)}`, { method: 'POST', body: JPEG })).status,
    ).toBe(204);
    expect(events.at(-1)).toEqual({ id, type: 'photo', seq: front, bytes: JPEG });
    expect(await next(url, 1)).toEqual({ v: 2, ask: null });

    // The next step goes to the same phone without a new code.
    const sign = server.ask(id, 'signature', 'Tanda tangan');
    expect((await next(url, 2)).ask).toEqual({
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
    const sent = await fetch(`${url}/send?seq=${String(sign)}`, {
      method: 'POST',
      body: JSON.stringify({ strokes }),
    });
    expect(sent.status).toBe(204);
    expect(events.at(-1)).toEqual({
      id,
      type: 'signature',
      seq: sign,
      strokes: [
        [
          { x: 10, y: 20 },
          { x: 800, y: 0 },
        ],
      ],
      pad: { width: 800, height: 400 },
    });
  });

  it('refuses a send for a step the counter backed out of or replaced', async () => {
    const { url, id, events } = await paired();
    const first = server.ask(id, 'photo', 'Depan')!;
    server.withdraw(id, first);
    expect((await next(url, 1)).ask).toBeNull();
    expect(
      (await fetch(`${url}/send?seq=${String(first)}`, { method: 'POST', body: JPEG })).status,
    ).toBe(409);
    const second = server.ask(id, 'photo', 'Belakang')!;
    const third = server.ask(id, 'photo', 'Atas')!;
    expect(
      (await fetch(`${url}/send?seq=${String(second)}`, { method: 'POST', body: JPEG })).status,
    ).toBe(409);
    expect(events).toEqual([]);
    expect(
      (await fetch(`${url}/send?seq=${String(third)}`, { method: 'POST', body: JPEG })).status,
    ).toBe(204);
  });

  it('refuses what is not a photo, and a wrong key, without spending the step', async () => {
    const { url, id, events } = await paired();
    const seq = server.ask(id, 'photo', 'Depan')!;
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(
      (await fetch(`${url}/send?seq=${String(seq)}`, { method: 'POST', body: png })).status,
    ).toBe(415);
    const wrong = url.replace(/\/h\/.{32}$/, `/h/${'A'.repeat(32)}`);
    expect((await fetch(wrong)).status).toBe(410);
    expect(
      (await fetch(`${wrong}/send?seq=${String(seq)}`, { method: 'POST', body: JPEG })).status,
    ).toBe(410);
    expect((await fetch(url.replace(/\/h\/.*$/, '/'))).status).toBe(404);
    expect(events).toEqual([]);
    expect(
      (await fetch(`${url}/send?seq=${String(seq)}`, { method: 'POST', body: JPEG })).status,
    ).toBe(204);
  });

  it('refuses an empty or malformed signature, and one past the size limit', async () => {
    const { url, id } = await paired();
    const seq = server.ask(id, 'signature', 'Tanda tangan')!;
    for (const body of ['nope', '{"strokes":[]}', '{"strokes":[[{"x":"1","y":2}]]}']) {
      expect((await fetch(`${url}/send?seq=${String(seq)}`, { method: 'POST', body })).status).toBe(
        400,
      );
    }
    const huge = new Uint8Array(2 * 1024 * 1024).fill(32);
    expect(
      (await fetch(`${url}/send?seq=${String(seq)}`, { method: 'POST', body: huge })).status,
    ).toBe(413);
  });

  it('ends a pairing nobody uses for half an hour, and tells the counter', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { url, id, events } = await paired();
      vi.advanceTimersByTime(30 * 60 * 1000);
      expect(events.at(-1)).toEqual({ id, type: 'expired' });
      expect(server.ask(id, 'photo', 'Depan')).toBeNull();
      vi.useRealTimers();
      await expect(fetch(url)).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a phone waiting for the next step hears when the pairing ends', async () => {
    const { url, id } = await paired();
    const waiting = fetch(`${url}/next?v=0`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    server.unpair(id);
    expect((await waiting).status).toBe(410);
  });

  it('a new code replaces the old, and unpairing closes the port', async () => {
    const first = await paired();
    const second = await server.pair(window().contents, LABELS);
    if (!second.ok) throw new Error(second.problem);
    expect((await fetch(second.urls[0]!)).status).toBe(200);
    const oldKey = first.url.split('/h/')[1]!;
    expect((await fetch(second.urls[0]!.replace(/[^/]+$/, oldKey))).status).toBe(410);
    server.unpair(second.id);
    await expect(fetch(second.urls[0]!)).rejects.toThrow();
  });

  it('lets the newer of two quick pairings win, leaving one port open', async () => {
    server = new HandoffServer(() => ['127.0.0.1']);
    const [first, second] = await Promise.all([
      server.pair(window().contents, LABELS),
      server.pair(window().contents, LABELS),
    ]);
    expect(first).toEqual({ ok: false, problem: 'failed' });
    if (!second.ok) throw new Error(second.problem);
    expect((await fetch(second.urls[0]!)).status).toBe(200);
    server.unpair(second.id);
    await expect(fetch(second.urls[0]!)).rejects.toThrow();
  });

  it('unpairs when the counter page reloads', async () => {
    server = new HandoffServer(() => ['127.0.0.1']);
    const handlers = new Map<string, () => void>();
    const contents = {
      isDestroyed: () => false,
      send: () => undefined,
      once: (name: string, handler: () => void) => handlers.set(name, handler),
      off: (name: string) => handlers.delete(name),
    } as unknown as WebContents;
    const opened = await server.pair(contents, LABELS);
    if (!opened.ok) throw new Error(opened.problem);
    handlers.get('did-start-loading')!();
    await expect(fetch(opened.urls[0]!)).rejects.toThrow();
    expect(handlers.size).toBe(0);
  });

  it('says so when the PC is on no store network', async () => {
    server = new HandoffServer(() => []);
    expect(await server.pair(window().contents, LABELS)).toEqual({
      ok: false,
      problem: 'noNetwork',
    });
  });
});

describe('store network addresses', () => {
  it('offers private IPv4 addresses, real adapters before virtual ones', () => {
    const entry = (address: string, family = 'IPv4', internal = false) => ({
      address,
      family,
      internal,
      netmask: '255.255.255.0',
      mac: '00:00:00:00:00:00',
      cidr: null,
    });
    expect(
      lanAddresses({
        'vEthernet (WSL)': [entry('172.20.0.1')],
        'Wi-Fi': [entry('192.168.1.23'), entry('fe80::1', 'IPv6')],
        Loopback: [entry('127.0.0.1', 'IPv4', true)],
        Public: [entry('8.8.4.4')],
        Ethernet: [entry('10.0.0.5')],
      } as never),
    ).toEqual(['192.168.1.23', '10.0.0.5', '172.20.0.1']);
  });

  it('keeps strokes small', () => {
    const many = Array.from({ length: 501 }, () => [{ x: 1, y: 1 }]);
    expect(strokesOf({ strokes: many })).toBeNull();
    const long = [Array.from({ length: 20_001 }, () => ({ x: 1, y: 1 }))];
    expect(strokesOf({ strokes: long })).toBeNull();
  });
});
