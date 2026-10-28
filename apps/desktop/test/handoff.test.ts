// @vitest-environment node
// The phone handoff's page server, over real HTTP on this machine: what a phone gets and may send,
// and what reaches the counter window. A stand-in for the window records the events.
import type { WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HandoffEvent, HandoffPageLabels } from '../src/main/bridge.js';
import { HandoffServer, lanAddresses, strokesOf } from '../src/main/handoff.js';

vi.mock('electron', () => ({ ipcMain: {} }));

const LABELS: HandoffPageLabels = {
  title: 'Depan <b>',
  hint: 'Ambil foto, lalu kirim ke komputer.',
  take: 'Ambil foto',
  retake: 'Ulangi',
  clear: 'Hapus',
  send: 'Kirim ke komputer',
  sending: 'Mengirim…',
  sent: 'Terkirim.',
  failed: 'Belum terkirim.',
  expired: 'Kedaluwarsa </script><script>alert(1)</script>',
  unreadable: 'Tidak bisa dibaca.',
};
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

let server: HandoffServer;
afterEach(() => server.cancel());

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

async function openOn(kind: 'photo' | 'signature'): Promise<{
  url: string;
  id: string;
  events: HandoffEvent[];
}> {
  server = new HandoffServer(() => ['127.0.0.1']);
  const { contents, events } = window();
  const opened = await server.open(contents, kind, LABELS);
  if (!opened.ok) throw new Error(opened.problem);
  return { url: opened.urls[0]!, id: opened.id, events };
}

describe('phone handoff', () => {
  it('serves the page once the code is scanned, with its copy escaped and scripts locked down', async () => {
    const { url, id, events } = await openOn('photo');
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/h\/[A-Za-z0-9_-]{32}$/);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const html = await response.text();
    expect(html).toContain('<title>Depan &#60;b&#62;</title>');
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('capture="environment"');
    expect(events).toEqual([{ id, type: 'opened' }]);
    // Opening it again (a reload) does not announce it twice.
    await fetch(url);
    expect(events).toHaveLength(1);
  });

  it('takes one JPEG from the phone and then stops answering', async () => {
    const { url, id, events } = await openOn('photo');
    const sent = await fetch(`${url}/send`, { method: 'POST', body: JPEG });
    expect(sent.status).toBe(204);
    expect(events.at(-1)).toEqual({ id, type: 'photo', bytes: JPEG });
    // The key is spent, and the port is closed.
    await expect(fetch(`${url}/send`, { method: 'POST', body: JPEG })).rejects.toThrow();
  });

  it('refuses what is not a photo, and a wrong key, without spending the code', async () => {
    const { url, events } = await openOn('photo');
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect((await fetch(`${url}/send`, { method: 'POST', body: png })).status).toBe(415);
    const wrong = url.replace(/\/h\/.{32}$/, `/h/${'A'.repeat(32)}`);
    expect((await fetch(wrong)).status).toBe(410);
    expect((await fetch(`${wrong}/send`, { method: 'POST', body: JPEG })).status).toBe(410);
    expect((await fetch(url.replace(/\/h\/.*$/, '/'))).status).toBe(404);
    expect(events).toEqual([]);
    expect((await fetch(`${url}/send`, { method: 'POST', body: JPEG })).status).toBe(204);
  });

  it('takes the drawn strokes for a signature, kept inside the pad', async () => {
    const { url, id, events } = await openOn('signature');
    const body = JSON.stringify({
      strokes: [
        [
          { x: 10, y: 20 },
          { x: 900, y: -5 },
        ],
      ],
    });
    const sent = await fetch(`${url}/send`, { method: 'POST', body });
    expect(sent.status).toBe(204);
    expect(events.at(-1)).toEqual({
      id,
      type: 'signature',
      strokes: [
        [
          { x: 10, y: 20 },
          { x: 800, y: 0 },
        ],
      ],
      pad: { width: 800, height: 400 },
    });
  });

  it('refuses an empty or malformed signature', async () => {
    const { url } = await openOn('signature');
    for (const body of ['nope', '{"strokes":[]}', '{"strokes":[[{"x":"1","y":2}]]}']) {
      expect((await fetch(`${url}/send`, { method: 'POST', body })).status).toBe(400);
    }
  });

  it('refuses an upload past the size limit', async () => {
    const { url } = await openOn('signature');
    const huge = new Uint8Array(2 * 1024 * 1024).fill(32);
    const response = await fetch(`${url}/send`, { method: 'POST', body: huge }).catch(() => null);
    // The server cuts the upload off; the phone sees a refusal or a dropped connection.
    expect(response === null || response.status === 413).toBe(true);
  });

  it('expires the code after ten minutes and tells the counter', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { url, id, events } = await openOn('photo');
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(events.at(-1)).toEqual({ id, type: 'expired' });
      vi.useRealTimers();
      await expect(fetch(url)).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels when the counter backs out, and a new code replaces the old', async () => {
    const first = await openOn('photo');
    const { contents } = window();
    const second = await server.open(contents, 'photo', LABELS);
    if (!second.ok) throw new Error(second.problem);
    expect((await fetch(`${second.urls[0]!}`)).status).toBe(200);
    const oldKey = first.url.split('/h/')[1]!;
    expect((await fetch(second.urls[0]!.replace(/[^/]+$/, oldKey))).status).toBe(410);
    server.cancel(second.id);
    await expect(fetch(second.urls[0]!)).rejects.toThrow();
  });

  it('lets the newer of two quick opens win, leaving one port open', async () => {
    server = new HandoffServer(() => ['127.0.0.1']);
    const [first, second] = await Promise.all([
      server.open(window().contents, 'photo', LABELS),
      server.open(window().contents, 'photo', LABELS),
    ]);
    expect(first).toEqual({ ok: false, problem: 'failed' });
    if (!second.ok) throw new Error(second.problem);
    expect((await fetch(second.urls[0]!)).status).toBe(200);
    server.cancel(second.id);
    await expect(fetch(second.urls[0]!)).rejects.toThrow();
  });

  it('stops waiting when the counter page reloads', async () => {
    server = new HandoffServer(() => ['127.0.0.1']);
    const handlers = new Map<string, () => void>();
    const contents = {
      isDestroyed: () => false,
      send: () => undefined,
      once: (name: string, handler: () => void) => handlers.set(name, handler),
      off: (name: string) => handlers.delete(name),
    } as unknown as WebContents;
    const opened = await server.open(contents, 'photo', LABELS);
    if (!opened.ok) throw new Error(opened.problem);
    handlers.get('did-start-loading')!();
    await expect(fetch(opened.urls[0]!)).rejects.toThrow();
    expect(handlers.size).toBe(0);
  });

  it('says so when the PC is on no store network', async () => {
    server = new HandoffServer(() => []);
    expect(await server.open(window().contents, 'photo', LABELS)).toEqual({
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
