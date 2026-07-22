// Shared types for the server op-acceptance pipeline (05 §8–9, 10-db §3). No HTTP here — the
// pipeline is a pure function of deps + batch (task 16 wires it to POST /v1/sync/push).
import type { CryptoPort, OperationScope, ProjectionRegistry } from '@bolusi/core';
import type { DB, ForTenant, TenantDb } from '@bolusi/db-server';
import type { RejectionCode, SignedOperation } from '@bolusi/schemas';

import type { DetectConflictsResult, SurfacedConflict } from '../sync/conflict-detection.js';

/**
 * The registry seam. The real (type, schemaVersion) → Zod payload registry is @bolusi/modules
 * (task 11); the pipeline consumes it through this interface so it neither depends on that task
 * nor re-decides the schema step per module.
 *
 *   - `unknown`  → the `type` is not in the server registry     ⇒ UNKNOWN_TYPE
 *   - `known` + `validate(payload) === false`                    ⇒ SCHEMA_INVALID
 */
export type RegistryResolution =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'known'; readonly validate: (payload: unknown) => boolean };

export interface OpRegistry {
  resolve(type: string, schemaVersion: number): RegistryResolution;
  /**
   * The op TYPE's declared envelope scope (01 §6; 05 §2.1) — `'store'` or `'tenant'` — or
   * `undefined` when no module declares the type.
   *
   * The scope step reads this to decide whether a `storeId = null` envelope is legal for this type
   * (05 §9.2): a STORE-scoped type carrying a null store is malformed, while a TENANT-scoped one
   * (`platform.user_locale_changed`) legitimately carries null. It is DERIVED from the module's
   * `OperationDeclaration.scope` (default `'store'`), never a hardcoded list here — a new
   * store-scoped op type is covered the moment its module declares it, and a module that means
   * "tenant" has to say so (CLAUDE.md §2.8: one implementation, not per-caller copies).
   *
   * `undefined` (unknown type) is deliberately NOT a rejection at the scope step: the schema step
   * owns that verdict and answers `UNKNOWN_TYPE` (05 §8), so returning `undefined` lets an unknown
   * type fall through to the code that names it correctly instead of mis-attributing it to scope.
   */
  scopeOf(type: string): OperationScope | undefined;
}

/** Everything the pipeline needs that is an I/O boundary or a not-yet-built collaborator. */
export interface OplogPipelineDeps {
  /** The tenant-bound transaction opener (RLS + set_config); @bolusi/db-server in production. */
  readonly forTenant: ForTenant;
  /** Ed25519 verify + SHA-256 over the JCS bytes (05 §3). */
  readonly crypto: CryptoPort;
  /** Server receipt clock — `receivedAt` and the skew window (05 §6). */
  readonly now: () => number;
  /** Fresh UUIDs for `device_anomalies` rows. */
  readonly newId: () => string;
  /** (type, schemaVersion) → payload validator (task 11's @bolusi/modules registry). */
  readonly registry: OpRegistry;
  /**
   * Op type → projection applier (04 §4) — the SAME appliers the client runs (04 §2, T-8). The
   * pipeline folds every ACCEPTED op into the server read models inside the push transaction
   * (10-db §3 step 6, 04 §5.1 step 6), advancing `applied_server_seq` via the server watermark
   * store. Empty until a module registers (tasks 17/25/43) — with no registered applier every
   * accepted op is a defined no-op (engine.ts: `unregistered`), so the log fills but no projection
   * moves, which is the honest v0 state of a server that folds no modules yet. Derived from the
   * SAME module list as `registry` at the composition root (deps.ts), so validation and folding
   * never diverge (CLAUDE.md §2.8).
   */
  readonly projections: ProjectionRegistry<DB>;
  /**
   * Conflict detection (01 §8.2), run AFTER the acceptance loop inside the push transaction
   * (10-db §3). Injected so the pipeline neither owns the rules nor depends on the system-device
   * key material; absent ⇒ no detection (a deployment that pushes but detects nothing).
   *
   * It receives the pipeline's OWN transaction handle — that is the atomicity contract: the
   * detection ops it emits are inserted, chained and folded in this transaction, so they commit
   * with the push or vanish with it.
   */
  readonly detectConflicts?: (
    db: TenantDb,
    tenantId: string,
    accepted: readonly SignedOperation[],
  ) => Promise<DetectConflictsResult>;
  /**
   * Fired once per SURFACED (significant) conflict, AFTER the transaction commits (03 §7). `deps.ts`
   * binds it to push category `conflict` by default (task 134); absent ⇒ no delivery.
   */
  readonly onConflictSurfaced?: (conflict: SurfacedConflict) => Promise<void>;
  /**
   * Fired once per pushing device that had ≥1 `device_anomalies` row written in this batch
   * (BAD_SIGNATURE / CHAIN_BROKEN / SCOPE_VIOLATION / CLOCK_SKEW — anomalies.ts), AFTER the
   * transaction commits. `deps.ts` binds it to push category `device` by default (api/04-push §3;
   * task 134): owner devices are alerted a device misbehaved. Collected then fired post-commit for
   * the same two reasons as `onConflictSurfaced` — a rolled-back anomaly must not alert, and
   * delivery I/O must not run under the tenant counter lock. Absent ⇒ no delivery.
   */
  readonly onDeviceAnomaly?: (params: {
    readonly tenantId: string;
    readonly deviceId: string;
  }) => Promise<void>;
}

/** The token-authenticated device pushing this batch (api/01 §2; task 16 supplies it). */
export interface PushIdentity {
  readonly deviceId: string;
  readonly tenantId: string;
}

/**
 * Per-op result — the api/01 §3 union the client marks each local op against (03 §3):
 *   accepted → `synced` (+ serverSeq), duplicate → `synced`, rejected → `rejected` (+ code).
 */
export type PushOpResult =
  | { readonly id: string; readonly status: 'accepted'; readonly serverSeq: number }
  | { readonly id: string; readonly status: 'duplicate' }
  | {
      readonly id: string;
      readonly status: 'rejected';
      readonly code: RejectionCode;
      readonly reason: string;
    };

export interface ProcessPushResult {
  readonly results: readonly PushOpResult[];
}

/** The directory row for the pushing device, loaded once inside the push transaction. */
export interface DeviceRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string | null;
  readonly kind: 'member' | 'system';
  readonly status: 'active' | 'revoked';
  readonly publicKey: Uint8Array;
  readonly lastSeq: number;
  readonly lastHash: string | null;
  readonly lastSyncAt: number | null;
}

/** The batch being processed, ascending by per-device seq (api/01 §3). */
export type PushBatch = readonly SignedOperation[];
