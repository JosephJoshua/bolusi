// POST /v1/sync/push orchestration (api/01-sync §3). Wires the task-07 op-acceptance pipeline
// (`processPushBatch` — in-order per-op validation, gapless serverSeq, CHAIN_HALTED remainder,
// device anomalies, all inside ONE forTenant transaction) to the wire, then emits a scoped
// `sync.poke` for the accepted ops' pull scope. This task adds NO validation logic — it surfaces
// the pipeline's per-op results faithfully (05 §8) and never reshapes a rejection into an HTTP
// error (HTTP errors ≠ op rejections, api/00 §6).
import { processPushBatch, type OpRegistry } from '../oplog/index.js';
import type { OplogPipelineDeps } from '../oplog/types.js';
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
  /** (type, schemaVersion) → payload validator. Carries `platform.*` (task 17); `notes.*` (25) and
   *  `auth.*` (43) are UNKNOWN_TYPE until those modules register. */
  readonly registry: OpRegistry;
  /** Op type → projection applier (04 §4) for the pipeline's apply step. Carries the `platform`
   *  appliers (task 17); 25/43 still fold nothing. Derived from the same list as `registry`. */
  readonly projections: ProjectionRegistry<DB>;
  /** Scoped poke publisher (api/00 §12.1); default hub has zero subscribers (a no-op). */
  readonly pokeHub: PokeHub;
  /** Conflict detection (01 §8.2), run inside the push transaction. `undefined` ⇒ disabled (no
   *  system key store configured — conflict-wiring.ts). Passed straight to the pipeline. */
  readonly detectConflicts?: OplogPipelineDeps['detectConflicts'];
  /** Post-commit hook for surfaced conflicts (03 §7). Task 21 subscribes; default absent. */
  readonly onConflictSurfaced?: OplogPipelineDeps['onConflictSurfaced'];
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
