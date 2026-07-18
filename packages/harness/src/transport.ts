// The sync transport building block (testing-guide §3.1 `net`, §3.6 CHAOS-02/03/04/06/12).
//
// The harness owns NO protocol logic (T-7): these adapters WIRE the production sync phases
// (`runPushPhase`/`runPullPhase`) to either the REAL in-process server over `FaultFetch` (no
// sockets) or, for the pull-injection scenario, a scripted `SyncTransportPort` that returns
// hand-built `PullResponse`s the way a compromised server would. The DTO shapes are `@bolusi/schemas`
// (`SyncTransportPort` speaks DTOs, never Response/status — sync/ports.ts); the HTTP framing here is
// exactly the thin adapter 08 §4.3 says lives in the client, not in core.
import {
  runPullPhase,
  runPushPhase,
  SyncTransportError,
  type PullPhaseResult,
  type PushPhaseResult,
  type SyncSurfacePort,
  type SyncSurfacing,
  type SyncTransportPort,
} from '@bolusi/core';
import { noblePort } from '@bolusi/test-support';
import type { PullRequest, PullResponse, PushRequest, PushResponse } from '@bolusi/schemas';

import type { VirtualDevice } from './device.js';
import type { FetchLike } from './fault-fetch.js';

const PUSH_URL = 'http://harness.test/v1/sync/push';
const PULL_URL = 'http://harness.test/v1/sync/pull';

/** The api/00 §7 error envelope a failed request carries. */
interface ErrorEnvelope {
  readonly error?: { readonly code?: string };
}

/**
 * The production HTTP sync transport (api/01-sync §3–§4) over an injected `fetch` — in the harness
 * that fetch is `FaultFetch(server.fetch)`, so every request is captured and any scheduled fault
 * (F1/F2) fires at its boundary. A non-2xx resolves into a `SyncTransportError` carrying the
 * envelope's `error.code` verbatim (sync/ports.ts: the loop discriminates on the code, never the
 * status), which is exactly how the loop tells `DEVICE_REVOKED` from a merely-expired token.
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

/**
 * A scripted `SyncTransportPort` (CHAOS-12): each `pull` shifts the next scripted `PullResponse`,
 * so the harness can serve a batch with an injected bad-signature op and an unknown-pubkey op the
 * way `api/01 §4.2`'s "trust, but verify" threat model requires. Push is unused here but implemented
 * so the port is total. Mirrors core's own `FakeTransport` (test/sync/_fixtures.ts) — one
 * implementation per package because that fixture is not exported (§2.8 does not reach test trees).
 */
export class ScriptedTransport implements SyncTransportPort {
  readonly pulls: PullRequest[] = [];
  readonly pushes: PushRequest[] = [];
  private readonly pullScript: PullResponse[] = [];

  scriptPull(...replies: readonly PullResponse[]): this {
    this.pullScript.push(...replies);
    return this;
  }

  push(request: PushRequest): Promise<PushResponse> {
    this.pushes.push(request);
    return Promise.resolve({ results: [], serverTime: 0 });
  }

  pull(request: PullRequest): Promise<PullResponse> {
    this.pulls.push(request);
    const next = this.pullScript.shift();
    if (next === undefined) {
      // Drained steady state: nothing more to serve, echo the cursor (never re-serve the world).
      return Promise.resolve({
        ops: [],
        nextCursor: request.cursor,
        hasMore: false,
        serverTime: 0,
      });
    }
    return Promise.resolve(next);
  }
}

/** A capturing surface (T-4): records every surfacing so a scenario asserts the KEY, never copy. */
export class CaptureSurface implements SyncSurfacePort {
  readonly events: SyncSurfacing[] = [];
  emit(event: SyncSurfacing): void {
    this.events.push(event);
  }
  ofKind<K extends SyncSurfacing['kind']>(kind: K): Array<Extract<SyncSurfacing, { kind: K }>> {
    return this.events.filter((e) => e.kind === kind) as Array<Extract<SyncSurfacing, { kind: K }>>;
  }
}

/** A surface that never records — the default when a scenario does not assert surfacings. */
export const SILENT_SURFACE: SyncSurfacePort = { emit: () => undefined };

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
