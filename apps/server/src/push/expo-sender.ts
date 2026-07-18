// The Expo push sender (api/04-push §7) — POSTs to the Expo push HTTP API, which relays via FCM v1.
//
// OUTWARD-FACING, so the HTTP call is an INJECTED transport (`PushTransport`), never a hard `fetch`
// and never `expo-server-sdk` (08 §3.3: no `expo-*` server-side; the boundary lint would flag it).
// Tests bind a recording transport and assert the request shape + batching + retry WITHOUT a
// network — and the fanout/SEC tests bind `FakePushPort` instead, so the real endpoint is never hit
// in CI (CLAUDE.md §6).
//
// Batching: ≤ 100 messages per `send` request (api/04-push §7). Retry (whole batch, on a
// request-level failure — network throw / 5xx / 429): the api/01-sync §6 schedule 5 s → 15 s → 60 s
// → 5 min cap, bounded at 5 attempts, then the batch is DROPPED — never queued durably, never
// re-sent (api/04-push §8, §1: pull is the source of truth). Per-message errors are surfaced as
// error tickets; `InvalidCredentials` additionally fires the alert hook (config problem, not data).
import type { OutgoingPush } from './payload.js';
import type { PushPort, PushReceipt, PushTicket } from './port.js';

export const EXPO_SEND_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';

/** Max messages per Expo send request (api/04-push §7). */
export const EXPO_MAX_BATCH = 100;

/** Retry backoff before each subsequent attempt (api/01-sync §6; ms), capped at 5 min. */
export const RETRY_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000] as const;
export const MAX_SEND_ATTEMPTS = 5;

/** An HTTP response the transport hands back. `ok` is false for any non-2xx (retry trigger). */
export interface PushHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

/** The injected HTTP seam. Production wraps `fetch`; tests record + script. A throw = network death
 *  (retryable). */
export type PushTransport = (url: string, body: unknown) => Promise<PushHttpResponse>;

export interface SenderLogEvent {
  readonly kind: 'message_error' | 'batch_dropped';
  readonly deviceId?: string;
  readonly category?: string;
  readonly error?: string;
}

export interface ExpoSenderOptions {
  readonly transport: PushTransport;
  /** Delay seam for retries — tests inject a controllable/immediate sleep (no real waiting). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Fired on an `InvalidCredentials` ticket (api/04-push §8) — a config alert, not a data event. */
  readonly onInvalidCredentials?: (event: { deviceId: string }) => void;
  /** Structured log sink (push failures are logged, never surfaced as sync errors — api/04-push §6). */
  readonly logger?: (event: SenderLogEvent) => void;
  readonly maxAttempts?: number;
}

/** The Expo wire message (api/04-push §4/§7): our internal `deviceId` is stripped. */
interface ExpoWireMessage {
  readonly to: string;
  readonly data: OutgoingPush['push']['data'];
  readonly title?: string;
  readonly body?: string;
  readonly channelId?: string;
}

function toWire(m: OutgoingPush): ExpoWireMessage {
  const base = { to: m.to, data: m.push.data };
  return 'title' in m.push
    ? { ...base, title: m.push.title, body: m.push.body, channelId: m.push.channelId }
    : base;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface ExpoTicket {
  status?: unknown;
  id?: unknown;
  message?: unknown;
  details?: { error?: unknown };
}

export class ExpoPushSender implements PushPort {
  readonly #transport: PushTransport;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #onInvalidCredentials: ((event: { deviceId: string }) => void) | undefined;
  readonly #logger: ((event: SenderLogEvent) => void) | undefined;
  readonly #maxAttempts: number;

  constructor(options: ExpoSenderOptions) {
    this.#transport = options.transport;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#onInvalidCredentials = options.onInvalidCredentials;
    this.#logger = options.logger;
    this.#maxAttempts = options.maxAttempts ?? MAX_SEND_ATTEMPTS;
  }

  async send(messages: readonly OutgoingPush[]): Promise<readonly PushTicket[]> {
    const tickets: PushTicket[] = [];
    for (const batch of chunk(messages, EXPO_MAX_BATCH)) {
      tickets.push(...(await this.#sendBatch(batch)));
    }
    return tickets;
  }

  async #sendBatch(batch: readonly OutgoingPush[]): Promise<PushTicket[]> {
    const wire = batch.map(toWire);
    for (let attempt = 0; attempt < this.#maxAttempts; attempt += 1) {
      const data = await this.#tryPost(wire);
      if (data !== null) return this.#mapTickets(batch, data);
      if (attempt < this.#maxAttempts - 1) {
        await this.#sleep(
          RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)] as number,
        );
      }
    }
    // Bounded retries exhausted: DROP the batch (never durable, never re-sent — §8). Each message
    // becomes an error ticket so a caller sees the count, but no receipt id is polled and no token
    // is invalidated (a request failure is not `DeviceNotRegistered`).
    for (const m of batch) {
      this.#logger?.({
        kind: 'batch_dropped',
        deviceId: m.deviceId,
        category: m.push.data.category,
      });
    }
    return batch.map((m) => ({
      deviceId: m.deviceId,
      token: m.to,
      status: 'error' as const,
      error: 'RequestFailed',
    }));
  }

  /** One POST attempt. Returns the `data[]` on success, or `null` to signal a retryable failure. */
  async #tryPost(wire: readonly ExpoWireMessage[]): Promise<ExpoTicket[] | null> {
    let res: PushHttpResponse;
    try {
      res = await this.#transport(EXPO_SEND_URL, wire);
    } catch {
      return null; // network death → retry
    }
    if (!res.ok) return null; // 5xx / 429 → retry
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      return null;
    }
    const data = (parsed as { data?: unknown }).data;
    if (!Array.isArray(data)) return null;
    return data as ExpoTicket[];
  }

  #mapTickets(batch: readonly OutgoingPush[], data: ExpoTicket[]): PushTicket[] {
    return batch.map((m, i) => {
      const t = data[i];
      if (t === undefined) {
        return { deviceId: m.deviceId, token: m.to, status: 'error', error: 'MissingTicket' };
      }
      if (t.status === 'ok' && typeof t.id === 'string') {
        return { deviceId: m.deviceId, token: m.to, status: 'ok', receiptId: t.id };
      }
      const error = typeof t.details?.error === 'string' ? t.details.error : 'Unknown';
      if (error === 'InvalidCredentials') this.#onInvalidCredentials?.({ deviceId: m.deviceId });
      this.#logger?.({
        kind: 'message_error',
        deviceId: m.deviceId,
        category: m.push.data.category,
        error,
      });
      return {
        deviceId: m.deviceId,
        token: m.to,
        status: 'error',
        error,
        ...(typeof t.message === 'string' ? { message: t.message } : {}),
      };
    });
  }

  async getReceipts(receiptIds: readonly string[]): Promise<ReadonlyMap<string, PushReceipt>> {
    const out = new Map<string, PushReceipt>();
    for (const ids of chunk(receiptIds, EXPO_MAX_BATCH)) {
      let res: PushHttpResponse;
      try {
        res = await this.#transport(EXPO_RECEIPTS_URL, { ids });
      } catch {
        continue; // a failed receipt fetch is retried on the next poll cycle, never fatal
      }
      if (!res.ok) continue;
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        continue;
      }
      const data = (parsed as { data?: Record<string, ExpoTicket> }).data;
      if (data === undefined || data === null) continue;
      for (const [id, r] of Object.entries(data)) {
        if (r.status === 'ok') {
          out.set(id, { status: 'ok' });
        } else {
          const error = typeof r.details?.error === 'string' ? r.details.error : 'Unknown';
          out.set(id, { status: 'error', error });
        }
      }
    }
    return out;
  }
}
