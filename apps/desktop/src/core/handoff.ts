// The counter PC's side of the phone handoff (apps/server handoff relay): it pairs a store phone
// through the server, puts each photo, signature or video step in front of it, and listens for
// what comes back, which the window then keeps like its own webcam photo, pad signature or clip. It runs in the core
// process because the device token does; the window only sees ids, steps and results.
import {
  HANDOFF_PAD,
  type HandoffAsk,
  type HandoffAskResponse,
  type HandoffEventsResponse,
  type HandoffPageLabels,
  type HandoffPairResponse,
} from '@bolusi/schemas';

import type { HandoffEvent, HandoffOpened } from './api.js';

export interface HandoffClientConfig {
  /** The server, no trailing slash. */
  readonly baseUrl: string;
  /** Read per call, never cached: a revoked PC stops at once. */
  readonly deviceToken: () => Promise<string | null>;
  /** Where the events go (the window). */
  readonly emit: (event: HandoffEvent) => void;
  readonly fetchImpl?: typeof fetch;
  /** Waits between tries after a failed collect; injected for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface HandoffClient {
  pair(labels: HandoffPageLabels): Promise<HandoffOpened>;
  /** The step's number, or null when the pairing is over (the window then pairs again). */
  ask(id: string, ask: HandoffAsk): Promise<number | null>;
  withdraw(id: string, seq: number): Promise<void>;
  unpair(id: string): Promise<void>;
  /** Stops listening (the core is stopping). */
  stop(): void;
}

/** How long a failed collect waits before trying again: short first, then steadier. */
const RETRY_MS = [1_000, 2_000, 5_000, 10_000] as const;

class Gone extends Error {}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function createHandoffClient(config: HandoffClientConfig): HandoffClient {
  const doFetch = config.fetchImpl ?? fetch;
  const sleep = config.sleep ?? defaultSleep;
  /** The pairing being listened to; a new pair or an unpair stops the old loop. */
  let listening: { readonly id: string; readonly abort: AbortController } | null = null;

  async function call(
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<Response> {
    const token = await config.deviceToken();
    if (token === null) throw new Gone('this PC is not enrolled');
    const response = await doFetch(`${config.baseUrl}/v1/handoff${path}`, {
      ...init,
      ...(signal === undefined ? {} : { signal }),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
    });
    if (response.status === 404) throw new Gone('the pairing is over');
    if (!response.ok) throw new Error(`handoff ${path}: HTTP ${String(response.status)}`);
    return response;
  }

  const stopListening = (): void => {
    listening?.abort.abort();
    listening = null;
  };

  /**
   * The clip the phone sent for `seq`, fetched on its own (it is too big for the events); tried
   * again while the PC is offline, and null once the server no longer holds it.
   */
  async function fetchClip(
    id: string,
    seq: number,
    abort: AbortController,
  ): Promise<Uint8Array | null> {
    for (let failures = 0; !abort.signal.aborted; failures += 1) {
      try {
        const response = await call(
          `/${encodeURIComponent(id)}/clip/${String(seq)}`,
          {},
          abort.signal,
        );
        return new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        if (abort.signal.aborted || error instanceof Gone) return null;
        await sleep(RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]!);
      }
    }
    return null;
  }

  async function listen(id: string, abort: AbortController): Promise<void> {
    let after = 0;
    let failures = 0;
    while (!abort.signal.aborted) {
      let body: HandoffEventsResponse;
      try {
        const response = await call(
          `/${encodeURIComponent(id)}/events?after=${String(after)}`,
          {},
          abort.signal,
        );
        body = (await response.json()) as HandoffEventsResponse;
        failures = 0;
      } catch (error) {
        if (abort.signal.aborted) return;
        if (error instanceof Gone) body = { events: [], ended: true };
        else {
          // Offline for a moment: keep the pairing and try again; the phone's send waits on the
          // server until the PC collects it.
          await sleep(RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]!);
          failures += 1;
          continue;
        }
      }
      if (abort.signal.aborted) return;
      for (const event of body.events) {
        after = Math.max(after, event.n);
        if (event.type === 'paired') config.emit({ id, type: 'paired' });
        else if (event.type === 'photo') {
          const bytes = Buffer.from(event.jpeg, 'base64');
          config.emit({ id, type: 'photo', seq: event.seq, bytes: new Uint8Array(bytes) });
        } else if (event.type === 'video') {
          const bytes = await fetchClip(id, event.seq, abort);
          if (abort.signal.aborted) return;
          if (bytes !== null) {
            config.emit({ id, type: 'video', seq: event.seq, bytes, mime: event.mime });
          }
        } else {
          config.emit({
            id,
            type: 'signature',
            seq: event.seq,
            strokes: event.strokes.map((stroke) => stroke.map(({ x, y }) => ({ x, y }))),
            pad: HANDOFF_PAD,
          });
        }
      }
      if (body.ended) {
        if (listening?.id === id) listening = null;
        config.emit({ id, type: 'expired' });
        return;
      }
    }
  }

  return {
    async pair(labels) {
      stopListening();
      let paired: HandoffPairResponse;
      try {
        const response = await call('', { method: 'POST', body: JSON.stringify({ labels }) });
        paired = (await response.json()) as HandoffPairResponse;
      } catch (error) {
        // No token, no server or no internet look the same to the person: the PC is not online.
        return {
          ok: false,
          problem: error instanceof TypeError || error instanceof Gone ? 'offline' : 'failed',
        };
      }
      const abort = new AbortController();
      listening = { id: paired.id, abort };
      void listen(paired.id, abort);
      return { ok: true, id: paired.id, urls: [`${config.baseUrl}${paired.path}`] };
    },
    async ask(id, ask) {
      try {
        const response = await call(`/${encodeURIComponent(id)}/ask`, {
          method: 'POST',
          body: JSON.stringify(ask),
        });
        return ((await response.json()) as HandoffAskResponse).seq;
      } catch (error) {
        if (error instanceof Gone) return null;
        throw error;
      }
    },
    async withdraw(id, seq) {
      await call(`/${encodeURIComponent(id)}/withdraw`, {
        method: 'POST',
        body: JSON.stringify({ seq }),
      }).catch(() => undefined);
    },
    async unpair(id) {
      if (listening?.id === id) stopListening();
      await call(`/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined);
    },
    stop: stopListening,
  };
}
