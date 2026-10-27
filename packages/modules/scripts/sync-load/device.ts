// One simulated device, following the real client's sync rules (packages/core sync loop + realtime
// controller): a cycle pushes everything pending, pulls until caught up, then refreshes the device
// bundle with its ETag (at most every `bundleIntervalMs`). Cycles are single-flight with one coalesced rerun. Triggers are a change being
// made (debounced 1 s), a live-update poke, the 60 s periodic tick, and (re)connecting the live channel.
// A failed cycle backs off 5 s, 15 s, 60 s, then 300 s, absorbing every trigger except reconnection.
//
// It does not verify or store what it pulls; `applyMsPerOp` stands in for the phone's own work so a
// first sync asks for pages at a phone's pace rather than as fast as the network allows.
import type { PullResponse, PushResponse, SignedOperation } from '@bolusi/schemas';

import type { SimIdentity } from './fleet.js';
import type { Recorder, Route } from './metrics.js';

const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000];
const APPEND_DEBOUNCE_MS = 1_000;
const PERIODIC_MS = 60_000;
const RECONNECT_MS = 5_000;
const BATCH = 500;

export interface DeviceOptions {
  readonly baseUrl: string;
  readonly recorder: () => Recorder;
  /** Store mates' delivery bookkeeping: called with each pulled change. */
  readonly onPulled: (device: SimDevice, op: SignedOperation) => void;
  readonly applyMsPerOp: number;
  /** The client's bundle refresh throttle (core `BUNDLE_REFRESH_INTERVAL_MS`); 0 refreshes every cycle. */
  readonly bundleIntervalMs: number;
}

class HttpFailure extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

export class SimDevice {
  online = false;
  cursor = 0;
  cycles = 0;
  bundleCalls = 0;
  readonly pending: SignedOperation[] = [];
  #directoryVersion = 0;
  #etag: string | null = null;
  #bundleAt = Number.NEGATIVE_INFINITY;
  #running: Promise<void> | null = null;
  #rerun = false;
  #failures = 0;
  #backoffUntil = 0;
  #backoffTimer: NodeJS.Timeout | null = null;
  #appendTimer: NodeJS.Timeout | null = null;
  #periodic: NodeJS.Timeout | null = null;
  #socket: WebSocket | null = null;
  #idleWaiters: (() => void)[] = [];

  constructor(
    readonly identity: SimIdentity,
    private readonly options: DeviceOptions,
  ) {}

  /** Why the device is not idle, for progress output. */
  get state(): string {
    return `${this.#running !== null ? 'running ' : ''}${this.pending.length} pending${this.#backoffTimer !== null ? ' backoff' : ''}`;
  }

  get busy(): boolean {
    return this.#running !== null || this.pending.length > 0 || this.#backoffTimer !== null;
  }

  /** Go online: open the live channel (whose connect runs a catch-up cycle) and start the tick. */
  connect(): void {
    this.online = true;
    this.#openSocket();
    if (this.#periodic === null) {
      // A random phase, as devices are switched on at different moments.
      const phase = Math.random() * PERIODIC_MS;
      this.#periodic = setTimeout(() => {
        this.#periodic = setInterval(() => this.trigger('periodic'), PERIODIC_MS);
        this.trigger('periodic');
      }, phase);
    }
  }

  disconnect(): void {
    this.online = false;
    if (this.#periodic !== null) clearInterval(this.#periodic);
    this.#periodic = null;
    this.#socket?.close();
    this.#socket = null;
  }

  /** A user action made changes on this device. */
  append(ops: readonly SignedOperation[]): void {
    this.pending.push(...ops);
    if (!this.online) return;
    if (this.#appendTimer !== null) clearTimeout(this.#appendTimer);
    this.#appendTimer = setTimeout(() => {
      this.#appendTimer = null;
      this.trigger('append');
    }, APPEND_DEBOUNCE_MS);
  }

  trigger(reason: 'append' | 'poke' | 'periodic' | 'connect' | 'retry'): void {
    if (!this.online) return;
    if (Date.now() < this.#backoffUntil) {
      if (reason !== 'connect') return;
      if (this.#backoffTimer !== null) clearTimeout(this.#backoffTimer);
      this.#backoffTimer = null;
      this.#backoffUntil = 0;
    }
    if (this.#running !== null) {
      this.#rerun = true;
      return;
    }
    this.#running = this.#cycle().finally(() => {
      this.#running = null;
      if (this.#rerun && this.online) {
        this.#rerun = false;
        this.trigger('retry');
      } else if (!this.busy) {
        for (const resolve of this.#idleWaiters.splice(0)) resolve();
      }
    });
  }

  /** Resolves once nothing is pending, running or waiting to retry. */
  idle(): Promise<void> {
    return this.busy
      ? new Promise((resolve) => this.#idleWaiters.push(resolve))
      : Promise.resolve();
  }

  #openSocket(): void {
    const url = `${this.options.baseUrl.replace(/^http/, 'ws')}/v1/realtime`;
    const started = performance.now();
    // Node's WebSocket (undici) accepts headers, which is how the app authenticates the upgrade.
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.identity.token}` },
    } as unknown as string[]);
    this.#socket = socket;
    socket.onopen = () => {
      this.options.recorder().request('connect', performance.now() - started, 101);
      this.trigger('connect');
    };
    socket.onmessage = () => {
      this.options.recorder().pokes += 1;
      this.trigger('poke');
    };
    socket.onerror = () => {
      this.options.recorder().request('connect', performance.now() - started, 599);
    };
    socket.onclose = () => {
      if (this.#socket !== socket || !this.online) return;
      this.#socket = null;
      setTimeout(() => {
        if (this.online && this.#socket === null) this.#openSocket();
      }, RECONNECT_MS);
    };
  }

  async #cycle(): Promise<void> {
    this.cycles += 1;
    try {
      while (this.pending.length > 0) {
        const batch = this.pending.slice(0, BATCH);
        const response = await this.#call<PushResponse>('push', '/v1/sync/push', {
          deviceId: this.identity.deviceId,
          ops: batch,
        });
        const acceptedAt = Date.now();
        const recorder = this.options.recorder();
        for (const result of response.results) {
          if (result.status === 'rejected')
            throw new Error(`rejected ${result.code}: ${result.reason}`);
          recorder.accepted.set(result.id, acceptedAt);
        }
        recorder.opsPushed += batch.length;
        this.pending.splice(0, batch.length);
      }
      for (;;) {
        const page = await this.#call<PullResponse>('pull', '/v1/sync/pull', {
          cursor: this.cursor,
          limit: BATCH,
          devicesDirectoryVersion: this.#directoryVersion,
        });
        if (page.devicesDirectoryVersion !== undefined) {
          this.#directoryVersion = page.devicesDirectoryVersion;
        }
        this.options.recorder().opsPulled += page.ops.length;
        for (const op of page.ops) this.options.onPulled(this, op);
        this.cursor = page.nextCursor;
        if (this.options.applyMsPerOp > 0 && page.ops.length > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, page.ops.length * this.options.applyMsPerOp),
          );
        }
        if (!page.hasMore) break;
      }
      const now = Date.now();
      if (now - this.#bundleAt >= this.options.bundleIntervalMs) {
        await this.#bundle();
        this.#bundleAt = now;
      }
      this.#failures = 0;
    } catch (error) {
      this.#failures += 1;
      const delay = BACKOFF_MS[Math.min(this.#failures, BACKOFF_MS.length) - 1]!;
      this.#backoffUntil = Date.now() + delay;
      this.#backoffTimer = setTimeout(() => {
        this.#backoffTimer = null;
        this.#backoffUntil = 0;
        this.trigger('retry');
      }, delay);
      if (!(error instanceof HttpFailure)) throw error;
    }
  }

  async #bundle(): Promise<void> {
    this.bundleCalls += 1;
    const started = performance.now();
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}/v1/devices/me/bundle`, {
        headers: {
          Authorization: `Bearer ${this.identity.token}`,
          ...(this.#etag === null ? {} : { 'If-None-Match': this.#etag }),
        },
      });
      if (response.ok) await response.arrayBuffer();
      else await response.body?.cancel();
    } catch {
      this.options.recorder().request('bundle', performance.now() - started, 599);
      throw new HttpFailure(599);
    }
    this.options.recorder().request('bundle', performance.now() - started, response.status);
    if (response.status === 304) return;
    if (!response.ok) throw new HttpFailure(response.status);
    this.#etag = response.headers.get('ETag');
  }

  async #call<T>(route: Route, path: string, body: unknown): Promise<T> {
    const started = performance.now();
    let response: Response;
    let text: string;
    try {
      response = await fetch(`${this.options.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.identity.token}`,
        },
        body: JSON.stringify(body),
      });
      text = await response.text();
    } catch {
      this.options.recorder().request(route, performance.now() - started, 599);
      throw new HttpFailure(599);
    }
    this.options.recorder().request(route, performance.now() - started, response.status);
    if (!response.ok) throw new HttpFailure(response.status);
    return JSON.parse(text) as T;
  }
}
