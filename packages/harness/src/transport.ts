// The sync transport building block (testing-guide §3.1 `net`, §3.6 CHAOS-02/03/04/06/12).
//
// The harness owns NO protocol logic (T-7): these adapters WIRE the production sync phases to either
// the REAL in-process server over `FaultFetch` (no sockets) or, for the pull-injection scenario, a
// scripted `SyncTransportPort` that returns hand-built `PullResponse`s the way a compromised server
// would. The DTO shapes are `@bolusi/schemas` (`SyncTransportPort` speaks DTOs, never Response/status —
// sync/ports.ts); the HTTP framing is exactly the thin adapter 08 §4.3 says lives in the client.
//
// The PLATFORM-free half — `HttpTransport`, `pushDevice`, `pullDevice`, `SILENT_SURFACE` — moved into
// the bundle-safe shared rig `@bolusi/test-support/chaos` (task 198) so the on-device CHAOS-03/06/07
// runners can reuse it without importing @bolusi/harness (which drags PGlite + @hono/node-server). It
// is re-exported here so every existing scenario import (`from '../src/transport.js'`) is unchanged.
// `ScriptedTransport` (CHAOS-12) and `CaptureSurface` (surfacing assertions) stay Node-scenario-only.
import type { SyncSurfacePort, SyncSurfacing, SyncTransportPort } from '@bolusi/core';
import type { PullRequest, PullResponse, PushRequest, PushResponse } from '@bolusi/schemas';

export {
  HttpTransport,
  CountingTransport,
  pullDevice,
  pushDevice,
  SILENT_SURFACE,
} from '@bolusi/test-support/chaos';

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
