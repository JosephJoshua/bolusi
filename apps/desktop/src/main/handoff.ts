// Taking photos and signatures on a store phone when this PC has no webcam or touch screen. The PC
// serves one small page on the store's network; the QR it shows carries that page's address with a
// secret key. The phone opens it once in its own browser and stays paired: every photo or
// signature the counter asks for after that appears on the phone by itself, and what the phone
// sends comes back to this PC, which keeps it as its own capture. Nothing goes through the
// internet. The port is open only while a phone is paired, and the pairing ends when the counter
// says so, its page reloads, or nothing happens for half an hour.
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';

import type { HandoffEvent, HandoffKind, HandoffOpened, HandoffPageLabels } from './bridge.js';
import { handoffPage } from './handoff-page.js';

/** A pairing nobody uses for this long ends, and its QR stops working. */
const IDLE_MS = 30 * 60 * 1000;
/** How long the phone's ask for the next step is held open before it asks again. */
const POLL_MS = 20_000;
// The phone page sends a JPEG scaled to at most 1600 px; a few MB at most. Strokes are small.
const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 1024 * 1024;
const MAX_STROKES = 500;
const MAX_POINTS = 20_000;
const MAX_LABEL_CHARS = 300;
export const PAD = { width: 800, height: 400 } as const;

const LABEL_KEYS = [
  'photoHint',
  'signatureHint',
  'take',
  'retake',
  'clear',
  'send',
  'sending',
  'sent',
  'waiting',
  'rotate',
  'rotateNow',
  'failed',
  'withdrawn',
  'expired',
  'unreadable',
] as const satisfies readonly (keyof HandoffPageLabels)[];

interface Ask {
  readonly seq: number;
  readonly kind: HandoffKind;
  readonly title: string;
}

interface Pairing {
  readonly id: string;
  readonly key: string;
  readonly labels: HandoffPageLabels;
  readonly contents: WebContents;
  /** Stops watching the counter window. */
  readonly detach: () => void;
  idle: NodeJS.Timeout;
  paired: boolean;
  seq: number;
  /** What the phone should do now; changes bump `version`, which the phone waits on. */
  ask: Ask | null;
  version: number;
  readonly waiters: Set<() => void>;
}

/** The PC's addresses a phone on the same Wi-Fi can reach: private IPv4, real adapters first. */
export function lanAddresses(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
  const virtual = /vethernet|virtualbox|vmware|hyper-v|wsl|docker|loopback|tailscale|zerotier/i;
  const found: { address: string; virtual: boolean }[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !isPrivate(entry.address)) continue;
      found.push({ address: entry.address, virtual: virtual.test(name) });
    }
  }
  return found.sort((a, b) => Number(a.virtual) - Number(b.virtual)).map((entry) => entry.address);
}

function isPrivate(address: string): boolean {
  const [a, b] = address.split('.').map(Number);
  return (
    a === 10 || (a === 172 && b !== undefined && b >= 16 && b <= 31) || (a === 192 && b === 168)
  );
}

export function labelsOf(value: unknown): HandoffPageLabels | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const labels: Partial<Record<keyof HandoffPageLabels, string>> = {};
  for (const key of LABEL_KEYS) {
    const text = record[key];
    if (typeof text !== 'string' || text.length > MAX_LABEL_CHARS) return null;
    labels[key] = text;
  }
  return labels as HandoffPageLabels;
}

/** The strokes a phone sent, in the pad's 800 x 400 space, or null when they are not that. */
export function strokesOf(value: unknown): { x: number; y: number }[][] | null {
  if (typeof value !== 'object' || value === null) return null;
  const { strokes } = value as { strokes?: unknown };
  if (!Array.isArray(strokes) || strokes.length === 0 || strokes.length > MAX_STROKES) return null;
  let points = 0;
  const kept: { x: number; y: number }[][] = [];
  for (const stroke of strokes) {
    if (!Array.isArray(stroke)) return null;
    points += stroke.length;
    if (points > MAX_POINTS) return null;
    const line: { x: number; y: number }[] = [];
    for (const point of stroke) {
      const { x, y } = (point ?? {}) as { x?: unknown; y?: unknown };
      if (typeof x !== 'number' || typeof y !== 'number') return null;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      line.push({
        x: Math.min(PAD.width, Math.max(0, x)),
        y: Math.min(PAD.height, Math.max(0, y)),
      });
    }
    if (line.length > 0) kept.push(line);
  }
  return kept.length > 0 ? kept : null;
}

export const isJpeg = (bytes: Uint8Array): boolean =>
  bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

function readBody(request: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // Past the limit the rest is read and dropped, so the phone still gets its answer.
      if (size <= limit) chunks.push(chunk);
    });
    request.on('end', () => resolve(size <= limit ? Buffer.concat(chunks) : null));
    request.on('error', () => resolve(null));
  });
}

const SECURITY_HEADERS = {
  // Each request on its own connection, so closing the server leaves nothing open.
  Connection: 'close',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
} as const;

function reply(response: ServerResponse, status: number, body = '', type = 'text/plain'): void {
  if (response.headersSent) return;
  response.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': `${type}; charset=utf-8` });
  response.end(body);
}

export class HandoffServer {
  private server: Server | null = null;
  private starting: Promise<void> | null = null;
  private port = 0;
  private pairing: Pairing | null = null;
  /** Counts pairings, so one overtaken while the port was opening gives way to the newer. */
  private pairs = 0;

  constructor(private readonly addresses: () => string[] = lanAddresses) {}

  /** A new pairing for a new QR; any earlier one ends. */
  async pair(contents: WebContents, labels: HandoffPageLabels): Promise<HandoffOpened> {
    const turn = ++this.pairs;
    this.unpair();
    const hosts = this.addresses();
    if (hosts.length === 0) return { ok: false, problem: 'noNetwork' };
    try {
      await this.listen();
    } catch {
      return { ok: false, problem: 'failed' };
    }
    if (turn !== this.pairs) return { ok: false, problem: 'failed' };
    const id = randomUUID();
    const key = randomBytes(24).toString('base64url');
    // A reloaded or closed counter page can no longer take what the phone sends: unpair.
    const end = (): void => this.unpair(id);
    contents.once('did-start-loading', end);
    contents.once('destroyed', end);
    const detach = (): void => {
      contents.off('did-start-loading', end);
      contents.off('destroyed', end);
    };
    this.pairing = {
      id,
      key,
      labels,
      contents,
      detach,
      idle: this.idleTimer(id),
      paired: false,
      seq: 0,
      ask: null,
      version: 0,
      waiters: new Set(),
    };
    return {
      ok: true,
      id,
      urls: hosts.map((host) => `http://${host}:${String(this.port)}/h/${key}`),
    };
  }

  /** Puts one photo or signature in front of the phone; null when the pairing is gone. */
  ask(id: string, kind: HandoffKind, title: string): number | null {
    const pairing = this.current(id);
    if (pairing === null) return null;
    pairing.seq += 1;
    this.change(pairing, { seq: pairing.seq, kind, title });
    return pairing.seq;
  }

  /** The counter backed out of this step; the phone goes back to waiting. */
  withdraw(id: string, seq: number): void {
    const pairing = this.current(id);
    if (pairing?.ask?.seq === seq) this.change(pairing, null);
  }

  /** Ends the pairing; its key stops working and the port closes. */
  unpair(id?: string): void {
    const pairing = this.pairing;
    if (pairing === null || (id !== undefined && pairing.id !== id)) return;
    clearTimeout(pairing.idle);
    pairing.detach();
    this.pairing = null;
    for (const wake of pairing.waiters) wake();
    this.close();
  }

  private current(id: string): Pairing | null {
    return this.pairing?.id === id ? this.pairing : null;
  }

  private idleTimer(id: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      const pairing = this.current(id);
      if (pairing === null) return;
      this.unpair(id);
      this.send(pairing, { id, type: 'expired' });
    }, IDLE_MS);
    timer.unref();
    return timer;
  }

  private touch(pairing: Pairing): void {
    clearTimeout(pairing.idle);
    pairing.idle = this.idleTimer(pairing.id);
  }

  private change(pairing: Pairing, ask: Ask | null): void {
    pairing.ask = ask;
    pairing.version += 1;
    this.touch(pairing);
    for (const wake of pairing.waiters) wake();
  }

  private send(pairing: Pairing, event: HandoffEvent): void {
    if (!pairing.contents.isDestroyed()) pairing.contents.send('handoff:event', event);
  }

  private listen(): Promise<void> {
    if (this.server !== null) return Promise.resolve();
    if (this.starting !== null) return this.starting;
    const server = createServer((request, response) => {
      void this.handle(request, response).catch(() => reply(response, 500));
    });
    // A phone that stops mid-upload must not hold the port open.
    server.requestTimeout = 60_000;
    server.headersTimeout = 10_000;
    this.starting = new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '0.0.0.0', () => {
        const address = server.address();
        this.port = typeof address === 'object' && address !== null ? address.port : 0;
        this.server = server;
        resolve();
      });
    }).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private close(): void {
    // Answers already on their way finish; nothing new gets in.
    this.server?.close();
    this.server?.closeIdleConnections();
    this.server = null;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://phone');
    const match = /^\/h\/([A-Za-z0-9_-]{32})(\/next|\/send)?$/.exec(url.pathname);
    const pairing = this.pairing;
    if (match === null) {
      reply(response, 404);
      return;
    }
    // A stale or wrong key gets the same answer as an expired one, so keys cannot be probed.
    if (pairing === null || match[1] !== pairing.key) {
      reply(response, 410);
      return;
    }
    const route = match[2];
    if (route === undefined) {
      if (request.method !== 'GET') {
        reply(response, 405);
        return;
      }
      this.page(pairing, response);
      return;
    }
    if (route === '/next') {
      if (request.method !== 'GET') {
        reply(response, 405);
        return;
      }
      await this.next(pairing, Number(url.searchParams.get('v') ?? '-1'), request, response);
      return;
    }
    if (request.method !== 'POST') {
      reply(response, 405);
      return;
    }
    await this.receive(pairing, Number(url.searchParams.get('seq') ?? '0'), request, response);
  }

  private page(pairing: Pairing, response: ServerResponse): void {
    const nonce = randomBytes(16).toString('base64');
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src blob:; connect-src 'self'; base-uri 'none'; form-action 'none'`,
    });
    response.end(
      handoffPage(pairing.labels, nonce, PAD, { strokes: MAX_STROKES, points: MAX_POINTS }),
    );
    this.touch(pairing);
    if (!pairing.paired) {
      pairing.paired = true;
      this.send(pairing, { id: pairing.id, type: 'paired' });
    }
  }

  /** Answers the phone's "what now?" as soon as the step changes, or after a while with no change. */
  private async next(
    pairing: Pairing,
    seen: number,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (pairing.version === seen) {
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          clearTimeout(timer);
          pairing.waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, POLL_MS);
        pairing.waiters.add(wake);
        response.once('close', wake);
      });
    }
    if (this.pairing !== pairing) {
      reply(response, 410);
      return;
    }
    reply(
      response,
      200,
      JSON.stringify({ v: pairing.version, ask: pairing.ask }),
      'application/json',
    );
  }

  private async receive(
    pairing: Pairing,
    seq: number,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const ask = pairing.ask;
    const body = await readBody(
      request,
      ask?.kind === 'signature' ? MAX_SIGNATURE_BYTES : MAX_PHOTO_BYTES,
    );
    if (this.pairing !== pairing) {
      reply(response, 410);
      return;
    }
    // Sent for a step the counter has since backed out of or replaced.
    if (ask === null || pairing.ask !== ask || ask.seq !== seq) {
      reply(response, 409);
      return;
    }
    if (body === null) {
      reply(response, 413);
      return;
    }
    if (ask.kind === 'photo') {
      if (!isJpeg(body)) {
        reply(response, 415);
        return;
      }
      reply(response, 204);
      this.change(pairing, null);
      this.send(pairing, { id: pairing.id, type: 'photo', seq, bytes: new Uint8Array(body) });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      parsed = null;
    }
    const strokes = strokesOf(parsed);
    if (strokes === null) {
      reply(response, 400);
      return;
    }
    reply(response, 204);
    this.change(pairing, null);
    this.send(pairing, { id: pairing.id, type: 'signature', seq, strokes, pad: PAD });
  }
}

export function registerHandoff(
  handoff: HandoffServer,
  trusted: (event: IpcMainInvokeEvent) => boolean,
): void {
  const refuse = (): never => {
    throw new Error('refused');
  };
  ipcMain.handle('handoff:pair', (event, labels: unknown) => {
    const pageLabels = labelsOf(labels);
    if (!trusted(event) || pageLabels === null) refuse();
    return handoff.pair(event.sender, pageLabels!);
  });
  ipcMain.handle('handoff:ask', (event, id: unknown, kind: unknown, title: unknown) => {
    if (
      !trusted(event) ||
      typeof id !== 'string' ||
      (kind !== 'photo' && kind !== 'signature') ||
      typeof title !== 'string' ||
      title.length > MAX_LABEL_CHARS
    ) {
      refuse();
    }
    return handoff.ask(id as string, kind as HandoffKind, title as string);
  });
  ipcMain.handle('handoff:withdraw', (event, id: unknown, seq: unknown) => {
    if (!trusted(event) || typeof id !== 'string' || typeof seq !== 'number') refuse();
    handoff.withdraw(id as string, seq as number);
  });
  ipcMain.handle('handoff:unpair', (event, id: unknown) => {
    if (!trusted(event) || typeof id !== 'string') refuse();
    handoff.unpair(id as string);
  });
}
