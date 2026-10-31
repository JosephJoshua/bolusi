// The phone handoff relay: a counter PC without a webcam or touch screen pairs a store phone once,
// by QR, and the server carries each photo or signature between them. The PC holds one pairing at
// a time; the phone reaches it only through the pairing's secret key. Everything lives in memory
// on this one server process (like the realtime hub): a restart ends every pairing, and the PC
// shows a new code. Nothing here is stored or synced; the PC keeps what it receives as its own
// capture, which then syncs like any other. A clip is held here, one per pairing, until the PC
// has collected past it (so a fetch cut short can be tried again), backs out, or asks again.
import { randomBytes, timingSafeEqual } from 'node:crypto';

import {
  HANDOFF_LIMITS,
  HANDOFF_PAD,
  VIDEO_MIMES,
  type HandoffAsk,
  type HandoffPageLabels,
  type HandoffPoint,
  type HandoffWireEvent,
  type VideoMime,
} from '@bolusi/schemas';

import type { DevicePrincipal } from '../env.js';
import { magicBytesMatch } from '../media/assemble.js';
import { nodeHubScheduler, type HubScheduler, type HubTimerHandle } from '../realtime/hub.js';
import { uuidv7 } from '../uuidv7.js';

/** A pairing nobody uses for this long ends, and its QR stops working. */
export const HANDOFF_IDLE_MS = 30 * 60 * 1000;
/** How long a wait for news (the phone's or the PC's) is held open before it is answered empty. */
export const HANDOFF_POLL_MS = 20_000;
/** What the PC has not collected yet; a step at a time, so a handful at most. */
const MAX_PENDING_EVENTS = 8;

type Ask = HandoffAsk & { readonly seq: number };

/** A clip the phone sent, waiting for the PC to fetch it. */
export interface HandoffClip {
  readonly seq: number;
  /** Its event's number: once the PC collects past it, it has fetched the clip. */
  readonly n: number;
  readonly mime: VideoMime;
  readonly bytes: Uint8Array;
}

export interface HandoffSession {
  readonly id: string;
  readonly key: string;
  readonly deviceId: string;
  readonly tenantId: string;
  readonly labels: HandoffPageLabels;
  idle: HubTimerHandle;
  paired: boolean;
  /** Minted for the first browser to open the page. Only that browser may use the pairing after,
   *  so a photographed QR is useless once the store phone has scanned it. */
  phoneSecret: string | null;
  ended: boolean;
  seq: number;
  /** What the phone should do now; changes bump `version`, which the phone waits on. */
  ask: Ask | null;
  version: number;
  /** What the PC has not collected yet, numbered from `n`. */
  events: HandoffWireEvent[];
  n: number;
  clip: HandoffClip | null;
  /** A send is being read; a second one waits its turn (409) instead of filling memory. */
  receiving: boolean;
  readonly phoneWaiters: Set<() => void>;
  readonly pcWaiters: Set<() => void>;
}

/** Why the phone's send was refused, as the page's HTTP status. */
export type SendRefusal = 409 | 413 | 415 | 400;

/** The strokes a phone sent, in the pad's space, or null when they are not that. */
export function strokesOf(value: unknown): HandoffPoint[][] | null {
  if (typeof value !== 'object' || value === null) return null;
  const { strokes } = value as { strokes?: unknown };
  if (!Array.isArray(strokes) || strokes.length === 0 || strokes.length > HANDOFF_LIMITS.strokes) {
    return null;
  }
  let points = 0;
  const kept: HandoffPoint[][] = [];
  for (const stroke of strokes) {
    if (!Array.isArray(stroke)) return null;
    points += stroke.length;
    if (points > HANDOFF_LIMITS.points) return null;
    const line: HandoffPoint[] = [];
    for (const point of stroke) {
      const { x, y } = (point ?? {}) as { x?: unknown; y?: unknown };
      if (typeof x !== 'number' || typeof y !== 'number') return null;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      line.push({
        x: Math.min(HANDOFF_PAD.width, Math.max(0, x)),
        y: Math.min(HANDOFF_PAD.height, Math.max(0, y)),
      });
    }
    if (line.length > 0) kept.push(line);
  }
  return kept.length > 0 ? kept : null;
}

export const isJpeg = (bytes: Uint8Array): boolean => magicBytesMatch(bytes, 'image/jpeg');

/** What a clip's header says it is, or null when it is neither MP4 nor WebM. */
export const videoMimeOf = (bytes: Uint8Array): VideoMime | null =>
  VIDEO_MIMES.find((mime) => magicBytesMatch(bytes, mime)) ?? null;

/** The most a send for this step may carry. */
export function sendLimit(ask: Ask | null): number {
  if (ask?.kind === 'video') return HANDOFF_LIMITS.videoBytes;
  return ask?.kind === 'signature' ? HANDOFF_LIMITS.signatureBytes : HANDOFF_LIMITS.photoBytes;
}

export class HandoffRelay {
  private readonly byId = new Map<string, HandoffSession>();
  private readonly byKey = new Map<string, HandoffSession>();
  private readonly byDevice = new Map<string, HandoffSession>();

  constructor(
    private readonly scheduler: HubScheduler = nodeHubScheduler,
    private readonly now: () => number = Date.now,
  ) {}

  /** A new pairing for this PC; its earlier one, if any, ends. */
  pair(device: DevicePrincipal, labels: HandoffPageLabels): HandoffSession {
    const earlier = this.byDevice.get(device.deviceId);
    if (earlier !== undefined) this.end(earlier);
    const session: HandoffSession = {
      id: uuidv7(this.now()),
      key: randomBytes(24).toString('base64url'),
      deviceId: device.deviceId,
      tenantId: device.tenantId,
      labels,
      idle: { cancel: () => undefined },
      paired: false,
      phoneSecret: null,
      ended: false,
      seq: 0,
      ask: null,
      version: 0,
      events: [],
      n: 0,
      clip: null,
      receiving: false,
      phoneWaiters: new Set(),
      pcWaiters: new Set(),
    };
    session.idle = this.idleTimer(session);
    this.byId.set(session.id, session);
    this.byKey.set(session.key, session);
    this.byDevice.set(device.deviceId, session);
    return session;
  }

  /** The PC's own pairing; another device's, or one that ended, is not found. */
  forDevice(device: DevicePrincipal, id: string): HandoffSession | null {
    const session = this.byId.get(id);
    return session !== undefined &&
      session.deviceId === device.deviceId &&
      session.tenantId === device.tenantId
      ? session
      : null;
  }

  forKey(key: string): HandoffSession | null {
    return this.byKey.get(key) ?? null;
  }

  /** Puts one photo, signature or clip in front of the phone; a clip not fetched yet goes. */
  ask(session: HandoffSession, ask: HandoffAsk): number {
    session.seq += 1;
    session.clip = null;
    this.change(session, { ...ask, seq: session.seq });
    return session.seq;
  }

  /** The clip the phone sent for step `seq`, while it is still held. */
  clip(session: HandoffSession, seq: number): HandoffClip | null {
    return session.clip?.seq === seq ? session.clip : null;
  }

  /** The PC backed out of this step; the phone goes back to waiting. */
  withdraw(session: HandoffSession, seq: number): void {
    if (session.clip?.seq === seq) session.clip = null;
    if (session.ask?.seq === seq) this.change(session, null);
  }

  /** Ends the pairing; its key stops working and everyone waiting hears it. */
  end(session: HandoffSession): void {
    if (session.ended) return;
    session.ended = true;
    session.idle.cancel();
    this.byId.delete(session.id);
    this.byKey.delete(session.key);
    if (this.byDevice.get(session.deviceId) === session) this.byDevice.delete(session.deviceId);
    session.events = [];
    session.clip = null;
    wakeAll(session.phoneWaiters);
    wakeAll(session.pcWaiters);
  }

  /**
   * A browser opened the page with `presented` (its phone secret, if it has one). The first one
   * gets a new secret and the PC hears it is paired; later, only the browser holding that secret
   * may reopen it. Returns the secret to keep, or null when this browser is not the paired phone.
   */
  opened(session: HandoffSession, presented: string | undefined): string | null {
    if (session.phoneSecret === null) {
      session.phoneSecret = randomBytes(24).toString('base64url');
    } else if (!this.isPhone(session, presented)) {
      return null;
    }
    this.touch(session);
    if (!session.paired) {
      session.paired = true;
      this.emit(session, { type: 'paired' });
    }
    return session.phoneSecret;
  }

  /** Whether `presented` is the secret of the phone that opened this pairing. */
  isPhone(session: HandoffSession, presented: string | undefined): boolean {
    const secret = session.phoneSecret;
    if (secret === null || presented === undefined) return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(secret);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Waits until the phone's step changes from `seen`, the pairing ends, or a while passes. */
  async waitForStep(session: HandoffSession, seen: number, signal?: AbortSignal): Promise<void> {
    if (session.version !== seen || session.ended) return;
    await this.wait(session.phoneWaiters, signal);
  }

  /**
   * What the PC has not seen after `after`, waiting a while for something when there is nothing.
   * What it has seen is let go.
   */
  async collect(
    session: HandoffSession,
    after: number,
    signal?: AbortSignal,
  ): Promise<readonly HandoffWireEvent[]> {
    session.events = session.events.filter((event) => event.n > after);
    // Collecting past a clip's event means the PC has it.
    if (session.clip !== null && session.clip.n <= after) session.clip = null;
    if (session.events.length === 0 && !session.ended) {
      await this.wait(session.pcWaiters, signal);
    }
    return session.ended ? [] : session.events;
  }

  /** What the phone sent for step `seq`: kept for the PC, or refused with the page's status. */
  receive(session: HandoffSession, seq: number, body: Uint8Array): SendRefusal | null {
    const ask = session.ask;
    // Sent for a step the PC has since backed out of or replaced.
    if (ask?.seq !== seq) return 409;
    if (body.length > sendLimit(ask)) return 413;
    if (ask.kind === 'video') {
      const mime = videoMimeOf(body);
      if (mime === null) return 415;
      this.change(session, null);
      this.emit(session, { type: 'video', seq, mime, sizeBytes: body.length });
      session.clip = { seq, n: session.n, mime, bytes: body };
      return null;
    }
    if (ask.kind === 'photo') {
      if (!isJpeg(body)) return 415;
      this.change(session, null);
      this.emit(session, { type: 'photo', seq, jpeg: Buffer.from(body).toString('base64') });
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(body).toString('utf8'));
    } catch {
      parsed = null;
    }
    const strokes = strokesOf(parsed);
    if (strokes === null) return 400;
    this.change(session, null);
    this.emit(session, { type: 'signature', seq, strokes });
    return null;
  }

  private emit(
    session: HandoffSession,
    event:
      | { type: 'paired' }
      | { type: 'photo'; seq: number; jpeg: string }
      | { type: 'signature'; seq: number; strokes: HandoffPoint[][] }
      | { type: 'video'; seq: number; mime: VideoMime; sizeBytes: number },
  ): void {
    session.n += 1;
    session.events.push({ ...event, n: session.n });
    // A PC that stopped collecting must not grow this without bound.
    if (session.events.length > MAX_PENDING_EVENTS) session.events.shift();
    wakeAll(session.pcWaiters);
  }

  private change(session: HandoffSession, ask: Ask | null): void {
    session.ask = ask;
    session.version += 1;
    this.touch(session);
    wakeAll(session.phoneWaiters);
  }

  private idleTimer(session: HandoffSession): HubTimerHandle {
    return this.scheduler.setTimer(HANDOFF_IDLE_MS, () => this.end(session));
  }

  private touch(session: HandoffSession): void {
    session.idle.cancel();
    session.idle = this.idleTimer(session);
  }

  private wait(waiters: Set<() => void>, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = (): void => {
        timer.cancel();
        waiters.delete(wake);
        signal?.removeEventListener('abort', wake);
        resolve();
      };
      const timer = this.scheduler.setTimer(HANDOFF_POLL_MS, wake);
      waiters.add(wake);
      signal?.addEventListener('abort', wake);
    });
  }
}

function wakeAll(waiters: Set<() => void>): void {
  for (const wake of [...waiters]) wake();
}
