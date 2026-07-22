// POST /v1/sync/push orchestration (api/01-sync §3). Wires the task-07 op-acceptance pipeline
// (`processPushBatch` — in-order per-op validation, gapless serverSeq, CHAIN_HALTED remainder,
// device anomalies, all inside ONE forTenant transaction) to the wire, then emits a scoped
// `sync.poke` for the accepted ops' pull scope. This task adds NO validation logic — it surfaces
// the pipeline's per-op results faithfully (05 §8) and never reshapes a rejection into an HTTP
// error (HTTP errors ≠ op rejections, api/00 §6).
import { processPushBatch, type OpRegistry } from '../oplog/index.js';
import type { OplogPipelineDeps } from '../oplog/types.js';
import type { DeliveryDispatcher } from '../push/dispatcher.js';
import { sendSyncWake, type PushDeliveryDeps } from '../push/fanout.js';
import type { PokeHub, PokeScope } from '../realtime/poke-hub.js';
import type { CryptoPort, ProjectionRegistry } from '@bolusi/core';
import type { DB, ForTenant } from '@bolusi/db-server';
import type { PushRequest, PushResponse, PushResult } from '@bolusi/schemas';

/** The token-authenticated device pushing (api/00 §3): identity comes from the bearer token, never
 *  the body — a valid token cannot push as another device (05 §9.1, security-guide §4.1). */
export interface PushIdentity {
  readonly deviceId: string;
  readonly tenantId: string;
}

export interface PushDeps {
  readonly forTenant: ForTenant;
  /** Ed25519 verify + SHA-256 over the JCS bytes (05 §3) — the task-07 pipeline's crypto port. */
  readonly crypto: CryptoPort;
  readonly now: () => number;
  /** Fresh ids for `device_anomalies` rows (05 §3 alarm). */
  readonly newId: () => string;
  /** (type, schemaVersion) → payload validator. Carries all of SERVER_MODULES — `platform.*` (17),
   *  `auth.*` (43) and `notes.*` (25) are all registered; an unregistered type is UNKNOWN_TYPE. */
  readonly registry: OpRegistry;
  /** Op type → projection applier (04 §4) for the pipeline's apply step. Carries every SERVER_MODULES
   *  applier (`platform`/`auth`/`notes` all fold). Derived from the same list as `registry`. */
  readonly projections: ProjectionRegistry<DB>;
  /** Scoped poke publisher (api/00 §12.1); default hub has zero subscribers (a no-op). */
  readonly pokeHub: PokeHub;
  /** Conflict detection (01 §8.2), run inside the push transaction. `undefined` ⇒ disabled (no
   *  system key store configured — conflict-wiring.ts). Passed straight to the pipeline. */
  readonly detectConflicts?: OplogPipelineDeps['detectConflicts'];
  /** Post-commit hook for surfaced conflicts (03 §7). deps.ts binds push delivery by default. */
  readonly onConflictSurfaced?: OplogPipelineDeps['onConflictSurfaced'];
  /** Post-commit hook for device anomalies (api/04-push §3). deps.ts binds push delivery. */
  readonly onDeviceAnomaly?: OplogPipelineDeps['onDeviceAnomaly'];
  /** Push fan-out bundle (api/04-push §7). When present (with `deliveryDispatcher`), an accepted push
   *  also delivers a `sync` wake to the accepted scopes' in-scope, NOT-live-connected devices (§6).
   *  Absent ⇒ no wake (the pipeline-only suites that build their own PushDeps). */
  readonly pushDelivery?: PushDeliveryDeps;
  /** Fire-and-forget boundary for the `sync` wake (api/04-push §1/§6) — the delivery runs OFF the
   *  request path so an Expo outage never blocks the push response. */
  readonly deliveryDispatcher?: DeliveryDispatcher;
}

export async function runPush(
  deps: PushDeps,
  identity: PushIdentity,
  request: PushRequest,
): Promise<PushResponse> {
  // Body/token device binding (05 §9.1, security-guide §4.1): the body's `deviceId` must be the
  // token's device. A mismatch is a whole-request binding violation — no op is evaluated; every op
  // is `SCOPE_VIOLATION`. (Per-op `op.deviceId` binding is the pipeline's, done against this same
  // token device — the identity below is the TOKEN's, never the body's.)
  if (request.deviceId !== identity.deviceId) {
    return {
      results: request.ops.map<PushResult>((op) => ({
        id: op.id,
        status: 'rejected',
        code: 'SCOPE_VIOLATION',
        reason: 'push body deviceId does not match the authenticated device',
      })),
      serverTime: deps.now(),
    };
  }

  const { results } = await processPushBatch(
    {
      forTenant: deps.forTenant,
      crypto: deps.crypto,
      now: deps.now,
      newId: deps.newId,
      registry: deps.registry,
      projections: deps.projections,
      // Threaded straight through: the pipeline runs detection inside the push transaction and
      // fires the hook post-commit. Both undefined by default (no key store) — detection off.
      ...(deps.detectConflicts === undefined ? {} : { detectConflicts: deps.detectConflicts }),
      ...(deps.onConflictSurfaced === undefined
        ? {}
        : { onConflictSurfaced: deps.onConflictSurfaced }),
      ...(deps.onDeviceAnomaly === undefined ? {} : { onDeviceAnomaly: deps.onDeviceAnomaly }),
    },
    { deviceId: identity.deviceId, tenantId: identity.tenantId },
    request.ops,
  );

  // Emit one scoped poke per DISTINCT pull scope among the accepted ops (api/01-sync §4.1). An
  // op with a store pokes that store; a tenant-scoped (storeId null) op pokes the whole tenant.
  // All-duplicate or all-rejected pushes accept nothing → no scopes → no poke (the hub no-ops on
  // an empty publish). Duplicates and rejections change no reader's view, so they warrant no poke.
  const opsById = new Map(request.ops.map((op) => [op.id, op]));
  const scopes = new Map<string, PokeScope>();
  for (const result of results) {
    if (result.status !== 'accepted') continue;
    const op = opsById.get(result.id);
    if (op === undefined) continue;
    scopes.set(`${op.storeId ?? ''}`, { tenantId: identity.tenantId, storeId: op.storeId });
  }
  deps.pokeHub.publish([...scopes.values()]);

  // Post-commit `sync` wake (api/04-push §3/§6): the SAME accepted-op scopes the poke carries, but
  // delivered as a data-only push to the in-scope devices WITHOUT a live realtime connection (the
  // fanout filters on `liveConnections`; connected devices already got the poke, and the per-device
  // 60s coalescer caps it).
  //
  // FIRE-AND-FORGET, NOT awaited (api/04-push §1/§6). This is the common write path — awaiting the
  // Expo round-trip (network + retry backoff up to minutes) would make an in-contract Expo outage
  // block EVERY accepted sync push and pile up workers, i.e. push load-bearing on the latency axis.
  // `dispatch` starts the delivery OFF the request path and returns immediately; `sendSyncWake`
  // swallows every failure (§6). Absent `pushDelivery`/`deliveryDispatcher` (the pipeline-only test
  // deps) ⇒ no wake.
  if (deps.pushDelivery !== undefined && deps.deliveryDispatcher !== undefined) {
    const pushDelivery = deps.pushDelivery;
    const dispatcher = deps.deliveryDispatcher;
    for (const scope of scopes.values()) {
      dispatcher.dispatch(() =>
        sendSyncWake(pushDelivery, { tenantId: scope.tenantId, opStoreId: scope.storeId }),
      );
    }
  }

  return {
    results: results.map<PushResult>((result) =>
      result.status === 'accepted'
        ? { id: result.id, status: 'accepted', serverSeq: result.serverSeq }
        : result.status === 'duplicate'
          ? { id: result.id, status: 'duplicate' }
          : { id: result.id, status: 'rejected', code: result.code, reason: result.reason },
    ),
    serverTime: deps.now(),
  };
}
