// The sync transport building block (testing-guide §3.1 `net`, §3.6 CHAOS-02/03/04/06/12) — the
// PLATFORM-free half, lifted into the shared rig (task 198) so an on-device CHAOS-03/06/07 runner can
// drive the REAL server round-trip over the wire WITHOUT importing @bolusi/harness (which drags
// PGlite + @hono/node-server, both `node:`-only and un-bundleable on Hermes).
//
// It owns NO protocol logic (T-7): these adapters WIRE the production sync phases
// (`runPushPhase`/`runPullPhase`) to an injected `fetch`. On Node the harness binds either
// `FaultFetch(server.fetch)` (no socket) or `socketBaseFetch(url)` (a real loopback socket); on device
// the RN global `fetch` reaches the host over `10.0.2.2` / `adb reverse`. The DTO shapes are
// `@bolusi/schemas` (`SyncTransportPort` speaks DTOs, never Response/status — sync/ports.ts); the HTTP
// framing here is exactly the thin adapter 08 §4.3 puts in the client, not core.
//
// Bundle-safe: no `node:` builtin, no better-sqlite3, no @bolusi/harness edge — `noblePort` arrives via
// the sibling `../crypto/noble-port.js` (the same relative path device.ts uses), never the root
// `@bolusi/test-support` barrel (which pulls Node-only determinism helpers). `chaos-bundle-safe.test.ts`
// guards the no-`node:` claim.
import {
  runPullPhase,
  runPushPhase,
  SyncTransportError,
  type PullPhaseResult,
  type PushPhaseResult,
  type SyncSurfacePort,
  type SyncTransportPort,
} from '@bolusi/core';
import type { PullRequest, PullResponse, PushRequest, PushResponse } from '@bolusi/schemas';

import { noblePort } from '../crypto/noble-port.js';

import type { VirtualDevice } from './device.js';

/**
 * A `fetch`-shaped seam. On Node the harness injects `FaultFetch(server.fetch)` (no socket) or
 * `socketBaseFetch(url)` (a real loopback socket); on device the RN global `fetch`. It lives HERE — the
 * bundle-safe home {@link HttpTransport} consumes it — so both bindings and
 * `@bolusi/harness/fault-fetch` (which re-exports it) share ONE definition (§2.8).
 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const PUSH_URL = 'http://harness.test/v1/sync/push';
const PULL_URL = 'http://harness.test/v1/sync/pull';

/**
 * Wrap a `fetch` so the transports' fixed `harness.test` origin ({@link HttpTransport} POSTs to
 * {@link PUSH_URL}/{@link PULL_URL} above) is rewritten to a REAL base URL, preserving the path +
 * query. An in-process binding ignores the origin (Hono routes on the path via `app.request`); a real
 * socket cannot — `harness.test` has no DNS — so this swaps the origin for `baseUrl`. A trailing slash
 * on `baseUrl` is stripped so `${base}${path}` never doubles the separator. `fetchImpl` defaults to the
 * global `fetch` (Node's built-in on the host, the RN global reaching `10.0.2.2` / `adb reverse` on
 * device); a test injects a spy to read the URL the wrapper actually calls. This is the ONE origin
 * rewrite the Node `socketBaseFetch` (packages/harness/src/net-server.ts delegates here) and the
 * on-device CHAOS-03 net binding (apps/mobile) share, so it lives once (§2.8).
 */
export function baseUrlFetch(baseUrl: string, fetchImpl: FetchLike = fetch): FetchLike {
  const base = baseUrl.replace(/\/+$/, '');
  return (input, init) => {
    const requested = new URL(input);
    return fetchImpl(`${base}${requested.pathname}${requested.search}`, init);
  };
}

/** The api/00 §7 error envelope a failed request carries. */
interface ErrorEnvelope {
  readonly error?: { readonly code?: string };
}

/**
 * The production HTTP sync transport (api/01-sync §3–§4) over an injected `fetch`. A non-2xx resolves
 * into a `SyncTransportError` carrying the envelope's `error.code` verbatim (sync/ports.ts: the loop
 * discriminates on the code, never the status), which is exactly how the loop tells `DEVICE_REVOKED`
 * from a merely-expired token.
 */
export class HttpTransport implements SyncTransportPort {
  constructor(
    private readonly fetch: FetchLike,
    private readonly authorization: string,
  ) {}

  push(request: PushRequest): Promise<PushResponse> {
    return this.send<PushResponse>(PUSH_URL, request);
  }

  pull(request: PullRequest): Promise<PullResponse> {
    return this.send<PullResponse>(PULL_URL, request);
  }

  private async send<T>(url: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: 'POST',
        headers: { Authorization: this.authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      // A pre-response failure (F1 network drop, F2 lost response) — no status, no code (ports.ts).
      throw new SyncTransportError(error instanceof Error ? error.message : String(error), {
        code: null,
        status: null,
      });
    }
    if (response.status < 200 || response.status >= 300) {
      const envelope = (await response.json().catch(() => ({}))) as ErrorEnvelope;
      throw new SyncTransportError(`sync HTTP ${response.status}`, {
        code: envelope.error?.code ?? null,
        status: response.status,
      });
    }
    return (await response.json()) as T;
  }
}

/** A surface that never records — the default when a scenario does not assert surfacings. */
export const SILENT_SURFACE: SyncSurfacePort = { emit: () => undefined };

/**
 * A `SyncTransportPort` decorator that RECORDS the per-request wire op counts and delegates verbatim —
 * NO protocol logic of its own (T-7). It is the witness the wire-level properties rest on: CHAOS-03's
 * incremental-pull ("a redundant sync pulls an EMPTY page", `pulledSinceReset()` after `reset()`), and
 * CHAOS-06's non-vacuity ("the held-op pull actually RECEIVED ops to dedup", `pullOpCounts`). Both the
 * days-offline rig (chaos03.ts) and the replay rig (chaos06.ts) drive it, so it lives here in the shared
 * transport home rather than as a private twin in each (§2.8 rule-of-three: chaos03 + chaos06 were the
 * 2nd and 3rd copies; the Node harness scenario keeps its own pre-existing twin the task leaves
 * untouched, the next refactor's target).
 */
export class CountingTransport implements SyncTransportPort {
  readonly pushOpCounts: number[] = [];
  readonly pullOpCounts: number[] = [];
  constructor(private readonly inner: SyncTransportPort) {}

  push(request: PushRequest): Promise<PushResponse> {
    this.pushOpCounts.push(request.ops.length);
    return this.inner.push(request);
  }

  async pull(request: PullRequest): Promise<PullResponse> {
    const response = await this.inner.pull(request);
    this.pullOpCounts.push(response.ops.length);
    return response;
  }

  /** Total ops pulled since the last {@link reset} (the empty-page / received-count witness). */
  pulledSinceReset(): number {
    return this.pullOpCounts.reduce((a, b) => a + b, 0);
  }

  reset(): void {
    this.pushOpCounts.length = 0;
    this.pullOpCounts.length = 0;
  }
}

/**
 * Run the REAL push phase (sync/push.ts) for one device against a transport: read the device's
 * `local` ops verbatim from `signed_core_jcs`, batch at the api/01 §3 cap, mark each by its result.
 * `onChainBroken` is a no-op sink by default (the harness owns no `SyncState`); scenarios that assert
 * halting pass their own.
 */
export function pushDevice(
  device: VirtualDevice,
  transport: SyncTransportPort,
  options: {
    readonly surface?: SyncSurfacePort;
    readonly batchSize?: number;
    readonly onChainBroken?: () => Promise<void>;
  } = {},
): Promise<PushPhaseResult> {
  return runPushPhase({
    db: device.db,
    transport,
    surface: options.surface ?? SILENT_SURFACE,
    clock: { now: () => device.clock.now() },
    deviceId: device.identity.deviceId,
    onChainBroken: options.onChainBroken ?? (() => Promise.resolve()),
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
  });
}

/**
 * Run the REAL pull phase (sync/pull.ts) for one device against a transport: pull-until-drained,
 * verify every op against the sidecar directory, apply each batch ATOMICALLY on the device's single
 * connection, quarantine what fails, advance the cursor. This is the whole of CHAOS-02's pull half
 * and CHAOS-12's mechanism — driven verbatim, never re-implemented (T-7).
 */
export function pullDevice(
  device: VirtualDevice,
  transport: SyncTransportPort,
  options: { readonly surface?: SyncSurfacePort; readonly limit?: number } = {},
): Promise<PullPhaseResult> {
  return runPullPhase({
    db: device.db,
    transaction: (fn) => device.transaction(fn),
    transport,
    surface: options.surface ?? SILENT_SURFACE,
    crypto: noblePort,
    clock: { now: () => device.clock.now() },
    applyPulledOp: (op) => device.pullApply(op),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
}
