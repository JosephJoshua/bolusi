// The raw wire client (testing-guide §3 preamble / §3.6 CHAOS-05) — the ONE harness surface that
// POSTs hand-built `SignedOperation` JSON the production client refuses to construct: payloads
// mutated post-hash, chains re-signed with a foreign key, seqs swapped. It owns NO protocol logic
// (T-7): it does the HTTP framing (08 §4.3's thin client adapter) and returns the server's verbatim
// answer — the tampered ops themselves are built by task-07's `@bolusi/test-support/oplog-fixtures`
// builders + tamper transforms, and the ACCEPT/REJECT verdict is the REAL server pipeline's.
//
// It differs from `HttpTransport` (transport.ts) only in what it surfaces: `HttpTransport.push`
// throws a `SyncTransportError` on any non-2xx (it feeds the real sync loop, which discriminates on
// the code), whereas the rejection MATRIX must read BOTH channels uniformly — the per-op
// `results[].status`/`code` of a 200 (T1–T6/T8/T9) AND the HTTP `401` + `DEVICE_REVOKED` envelope of
// a receipt-time cut (T7) — so this returns the status and the parsed body instead of throwing.
import type { PushRequest, PushResponse } from '@bolusi/schemas';

import type { FetchLike } from './fault-fetch.js';

const PUSH_URL = 'http://harness.test/v1/sync/push';

/** The api/00 §7 error envelope a non-2xx push carries. */
interface ErrorEnvelope {
  readonly error?: { readonly code?: string };
}

/** The verbatim server answer to a raw push: the HTTP status plus whichever channel carried it. */
export interface RawPushResult {
  readonly httpStatus: number;
  /** The parsed `PushResponse` on a 2xx (per-op `results[]`); `undefined` on an HTTP error. */
  readonly response: PushResponse | undefined;
  /** The envelope `error.code` on a non-2xx (e.g. `DEVICE_REVOKED` for T7); `null` on a 2xx. */
  readonly errorCode: string | null;
}

/**
 * POST a (possibly tampered) push batch to the REAL server over `fetch` and return its verbatim
 * verdict. `fetch` is the harness's in-process `server.fetch` (or a `FaultFetch` wrapping it); the
 * batch's ops are hand-built by the caller with the test-support tamper builders.
 */
export async function rawPush(
  fetch: FetchLike,
  authorization: string,
  request: PushRequest,
): Promise<RawPushResult> {
  const response = await fetch(PUSH_URL, {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (response.status >= 200 && response.status < 300) {
    return {
      httpStatus: response.status,
      response: (await response.json()) as PushResponse,
      errorCode: null,
    };
  }
  const envelope = (await response.json().catch(() => ({}))) as ErrorEnvelope;
  return {
    httpStatus: response.status,
    response: undefined,
    errorCode: envelope.error?.code ?? null,
  };
}
