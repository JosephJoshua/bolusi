// Taking a photo or signature on a store phone when this PC has no webcam or touch screen. While
// the counter waits, the PC serves one small page on the store's network; the QR it shows carries
// that page's address with a one-time key. The phone opens it in its own browser, takes the photo
// or signature there and sends it back to this PC, which keeps it as its own capture. Nothing goes
// through the internet, and the port is open only while a handoff is waiting.
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';

import type { HandoffEvent, HandoffKind, HandoffOpened, HandoffPageLabels } from './bridge.js';
import { handoffPage } from './handoff-page.js';

/** How long a QR stays good: enough to find a phone and take the shot, short enough to go stale. */
const TTL_MS = 10 * 60 * 1000;
// The phone page sends a JPEG scaled to at most 1600 px; a few MB at most. Strokes are small.
const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 1024 * 1024;
const MAX_STROKES = 500;
const MAX_POINTS = 20_000;
const MAX_LABEL_CHARS = 300;
export const PAD = { width: 800, height: 400 } as const;

const LABEL_KEYS = [
  'title',
  'hint',
  'take',
  'retake',
  'clear',
  'send',
  'sending',
  'sent',
  'failed',
  'expired',
  'unreadable',
] as const satisfies readonly (keyof HandoffPageLabels)[];

interface Session {
  readonly id: string;
  readonly key: string;
  readonly kind: HandoffKind;
  readonly labels: HandoffPageLabels;
  readonly contents: WebContents;
  readonly timer: NodeJS.Timeout;
  /** Stops watching the counter window. */
  readonly detach: () => void;
  opened: boolean;
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
  response.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': `${type}; charset=utf-8` });
  response.end(body);
}

export class HandoffServer {
  private server: Server | null = null;
  private starting: Promise<void> | null = null;
  private port = 0;
  private session: Session | null = null;
  /** Counts opens, so one overtaken while the port was opening gives way to the newer. */
  private opens = 0;

  constructor(private readonly addresses: () => string[] = lanAddresses) {}

  async open(
    contents: WebContents,
    kind: HandoffKind,
    labels: HandoffPageLabels,
  ): Promise<HandoffOpened> {
    const turn = ++this.opens;
    this.cancel();
    const hosts = this.addresses();
    if (hosts.length === 0) return { ok: false, problem: 'noNetwork' };
    try {
      await this.listen();
    } catch {
      return { ok: false, problem: 'failed' };
    }
    if (turn !== this.opens) return { ok: false, problem: 'failed' };
    const id = randomUUID();
    const key = randomBytes(24).toString('base64url');
    const timer = setTimeout(() => this.finish(id, { id, type: 'expired' }), TTL_MS);
    timer.unref();
    // A reloaded or closed counter page can no longer take the result: stop waiting for it.
    const end = (): void => this.cancel(id);
    contents.once('did-start-loading', end);
    contents.once('destroyed', end);
    const detach = (): void => {
      contents.off('did-start-loading', end);
      contents.off('destroyed', end);
    };
    this.session = { id, key, kind, labels, contents, timer, detach, opened: false };
    return {
      ok: true,
      id,
      urls: hosts.map((host) => `http://${host}:${String(this.port)}/h/${key}`),
    };
  }

  /** Stops waiting; the page's key stops working and the port closes. */
  cancel(id?: string): void {
    if (this.session === null || (id !== undefined && this.session.id !== id)) return;
    clearTimeout(this.session.timer);
    this.session.detach();
    this.session = null;
    this.close();
  }

  private finish(id: string, event: HandoffEvent): void {
    const session = this.session;
    if (session === null || session.id !== id) return;
    this.cancel(id);
    if (!session.contents.isDestroyed()) session.contents.send('handoff:event', event);
  }

  private notify(event: HandoffEvent): void {
    const contents = this.session?.contents;
    if (contents !== undefined && !contents.isDestroyed()) contents.send('handoff:event', event);
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
    const match = /^\/h\/([A-Za-z0-9_-]{32})(\/send)?$/.exec(request.url ?? '');
    const session = this.session;
    if (match === null) {
      reply(response, 404);
      return;
    }
    // A stale or wrong key gets the same answer as an expired one, so keys cannot be probed.
    if (session === null || match[1] !== session.key) {
      reply(response, 410);
      return;
    }
    if (match[2] === undefined) {
      if (request.method !== 'GET') {
        reply(response, 405);
        return;
      }
      const nonce = randomBytes(16).toString('base64');
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src blob:; connect-src 'self'; base-uri 'none'; form-action 'none'`,
      });
      response.end(
        handoffPage(session.kind, session.labels, nonce, PAD, {
          strokes: MAX_STROKES,
          points: MAX_POINTS,
        }),
      );
      if (!session.opened) {
        session.opened = true;
        this.notify({ id: session.id, type: 'opened' });
      }
      return;
    }
    if (request.method !== 'POST') {
      reply(response, 405);
      return;
    }
    const body = await readBody(
      request,
      session.kind === 'photo' ? MAX_PHOTO_BYTES : MAX_SIGNATURE_BYTES,
    );
    if (this.session !== session) {
      reply(response, 410);
      return;
    }
    if (body === null) {
      reply(response, 413);
      return;
    }
    if (session.kind === 'photo') {
      if (!isJpeg(body)) {
        reply(response, 415);
        return;
      }
      reply(response, 204);
      this.finish(session.id, { id: session.id, type: 'photo', bytes: new Uint8Array(body) });
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
    this.finish(session.id, { id: session.id, type: 'signature', strokes, pad: PAD });
  }
}

export function registerHandoff(
  handoff: HandoffServer,
  trusted: (event: IpcMainInvokeEvent) => boolean,
): void {
  ipcMain.handle('handoff:open', (event, kind: unknown, labels: unknown) => {
    const pageLabels = labelsOf(labels);
    if (!trusted(event) || (kind !== 'photo' && kind !== 'signature') || pageLabels === null) {
      throw new Error('refused');
    }
    return handoff.open(event.sender, kind, pageLabels);
  });
  ipcMain.handle('handoff:cancel', (event, id: unknown) => {
    if (!trusted(event) || typeof id !== 'string') throw new Error('refused');
    handoff.cancel(id);
  });
}
