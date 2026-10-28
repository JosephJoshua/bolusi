// The fetch `SyncTransportPort` — api/01-sync §3/§4's wire, in the thin adapter layer.
//
// @bolusi/core is platform-free (08 §3.3 rule 3): the sync loop owns the push/pull sequence and
// knows nothing of `fetch`, headers or status codes. This file is the whole translation layer, and
// it is deliberately the same shape as `src/media/transport.ts` (task 18) rather than a second
// invention (§2.8).
//
// WHY THE `error.code`, NOT THE STATUS — this is the one that would brick a device. api/01-sync §2's
// revoked-device signal is a `401`, but so are `AUTH_TOKEN_MISSING` and `AUTH_TOKEN_INVALID`
// (apps/server/src/errors.ts maps all three to 401). `syncDisabled` has NO automatic exit (03 §10) —
// clearing it means re-enrolling the device — so an adapter that reported the status would let a
// merely-expired token permanently disable sync on a working device. `SyncTransportPort`'s own
// contract says carry the code verbatim; this file is where "verbatim" is actually done.
import { SyncTransportError, type SyncTransportPort } from '@bolusi/core';
import type { PullRequest, PullResponse, PushRequest, PushResponse } from '@bolusi/schemas';

export interface SyncTransportConfig {
  /** Base URL of the server, no trailing slash (08 §6.1's `EXPO_PUBLIC_API_URL`). */
  readonly baseUrl: string;
  /** The `bdt_`-prefixed device token (api/02-auth §3/§8), read at call time — never cached here. */
  readonly deviceToken: () => Promise<string | null>;
  /** Injected for tests; defaults to the global. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Parse an api/00 §7 error envelope out of a failed response.
 *
 * Tolerant on purpose: a proxy, a load balancer or a shop's captive portal can answer a sync POST
 * with HTML or an empty body, and the loop must still get a usable failure rather than a JSON parse
 * exception escaping the adapter. An unparseable body yields `code: null`, which the loop treats as
 * a network-class failure → backoff (03 §10) — the correct reading of "something between us and the
 * server answered".
 */
export async function toTransportError(response: Response): Promise<SyncTransportError> {
  let code: string | null = null;
  let message = `HTTP ${String(response.status)}`;
  try {
    const body: unknown = await response.json();
    const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    if (typeof error?.code === 'string') code = error.code;
    if (typeof error?.message === 'string') message = error.message;
  } catch {
    // Not JSON. `code` stays null ⇒ a network-class failure, never mistaken for DEVICE_REVOKED.
  }
  return new SyncTransportError(message, { code, status: response.status });
}

export function createFetchSyncTransport(config: SyncTransportConfig): SyncTransportPort {
  const doFetch = config.fetchImpl ?? fetch;

  async function post<T>(path: string, body: unknown): Promise<T> {
    const token = await config.deviceToken();
    if (token === null) {
      // Fail closed rather than send an unauthenticated request. api/01-sync requires the device
      // token on both endpoints, and an anonymous POST earns a 401 — whose `error.code` would be
      // `AUTH_TOKEN_MISSING`, not `DEVICE_REVOKED`, so the loop backs off rather than disabling.
      // Raising it here with that same code keeps the two paths indistinguishable to the loop,
      // which is correct: both mean "we have no token", and neither is a revocation.
      throw new SyncTransportError('no device token available', {
        code: 'AUTH_TOKEN_MISSING',
        status: null,
      });
    }
    const response = await doFetch(`${config.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await toTransportError(response);
    return (await response.json()) as T;
  }

  return {
    // NOTE — api/01-sync §1 wants gzipped request bodies on bad 3G, and these are sent PLAIN.
    // That is a stated gap, not an oversight: React Native's fetch has no request-body compression,
    // and hand-gzipping needs a native/pure-JS deflate that 08 §2.2 does not pin — adding one is a
    // spec-table change (CLAUDE.md §6). It costs bandwidth, never correctness: the §3 batch caps
    // (≤ 500 ops, ≤ 1 MiB gzipped) are enforced server-side against what actually arrives, and
    // `readPushBatch`'s batching is what keeps a request small. Filed rather than faked — a
    // `Content-Encoding: gzip` header on an uncompressed body would be the working-looking lie.
    async push(request: PushRequest): Promise<PushResponse> {
      return post<PushResponse>('/v1/sync/push', request);
    },

    async pull(request: PullRequest): Promise<PullResponse> {
      return post<PullResponse>('/v1/sync/pull', request);
    },
  };
}
