// The COMPOSITION-ROOT wiring for conflict detection (01 §8.2; 10-db §3) — the seam that turns the
// detection ENGINE (conflict-detection.ts) into the `detectConflicts` closure the production push
// route passes into the pipeline.
//
// ── WHY THIS FILE EXISTS, AND WHAT IT DELIBERATELY DOES NOT DECIDE ─────────────────────────────
//
// `detectConflicts` needs three things: the conflict registry (from `SERVER_MODULES`), the Rule-2
// checks (a constant), and — the hard one — the tenant's system-device Ed25519 PRIVATE KEY, to sign
// `platform.conflict_detected`. 01 §3.6 is explicit that this key lives in "the server secret store
// (deployment doc owns storage)", and there is NO secret-store loader anywhere in this server today
// (`config.ts` reads only the DB URL and port). So the KEY SOURCE is a deployment decision this file
// must not make — env var format, per-tenant file, KMS: all outward-facing (CLAUDE.md §6).
//
// So this file builds everything EXCEPT the key source, behind an injected `SystemKeyStore` port,
// and makes the v0 default HONEST rather than broken:
//
//   * A key store CONFIGURED  ⇒ `buildConflictDetection` returns a real `detectConflicts`; the push
//     route passes it; conflicts are detected, signed, emitted, and folded in production.
//   * NO key store (v0 default) ⇒ it returns `undefined`; the route passes `undefined`; the
//     pipeline's `detectConflicts` guard skips detection. Pushes still succeed — they simply do not
//     detect conflicts yet.
//
// THE ALTERNATIVE IS A TRAP, and naming it is the point. If detection were wired unconditionally and
// the key store threw when asked, then the FIRST time two devices actually collided the signer would
// throw INSIDE the push transaction, roll the whole push back, and the pushing device would get a
// 500 it can never get past — sync wedged for that tenant, triggered by ordinary concurrent editing.
// "Detect and fail" is worse than "do not detect yet". So the wiring is CONDITIONAL on a key store
// being present, exactly as projection folding is conditional on a module being in `SERVER_MODULES`
// (task 49): the seam is fully built and one injection away from live, and its absence is a visible,
// deliberate no-op, not a silent gap. The remaining work — provide a real `SystemKeyStore` — is a
// filed deployment task.
import type { AnyModuleDefinition } from '@bolusi/core';
import type { DB, TenantDb } from '@bolusi/db-server';

import {
  buildConflictRegistry,
  detectConflicts,
  NOTES_EDIT_AFTER_ARCHIVE,
  type DetectConflictsResult,
  type SystemIdentity,
} from './conflict-detection.js';
import { base64ToBytes } from '@bolusi/core';
import type { CryptoPort } from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';

import type { SystemSigner } from '../oplog/system-op.js';

/** The production `detectConflicts` closure shape — what the pipeline's optional dep expects. */
export type DetectConflictsFn = (
  db: TenantDb,
  tenantId: string,
  accepted: readonly SignedOperation[],
) => Promise<DetectConflictsResult>;

/**
 * The deployment-owned source of a tenant's system-device signing key (01 §3.6, 10-db §12).
 *
 * ONE method, returning `undefined` when the tenant has no configured key. `undefined` is not an
 * error here — a v0 store may know about no keys at all, which is the "detection off" default. A
 * store that HAS a tenant's key but cannot produce a signer for it is the error case, and that is
 * the store's to throw.
 */
export interface SystemKeyStore {
  /** A signer over the tenant's system-device Ed25519 key, or `undefined` if none is configured. */
  getSystemSigner(tenantId: string): Promise<SystemSigner | undefined> | SystemSigner | undefined;
}

/** The tenant's system actor + device directory row (01 §3.6), read inside the push transaction. */
async function loadSystemDirectory(
  db: TenantDb,
  tenantId: string,
): Promise<{ userId: string; deviceId: string; publicKey: Uint8Array }> {
  // The system actor: exactly one per tenant (`users.is_system = true`, I-11). RLS scopes this to
  // the tenant, so no `WHERE tenant_id` — the GUC is the filter (forTenant's contract).
  const user = await db
    .selectFrom('users')
    .select('id')
    .where('isSystem', '=', true)
    .executeTakeFirst();
  // The system device: exactly one per tenant (`devices.kind = 'system'`, storeId null — 01 §3.6).
  const device = await db
    .selectFrom('devices')
    .select(['id', 'signingKeyPublic'])
    .where('kind', '=', 'system')
    .executeTakeFirst();

  if (user === undefined || device === undefined) {
    // An invariant break (I-11: the system actor + device exist exactly once per tenant), not a
    // per-op rejection. A tenant provisioned by `provision-tenant` always has both; a tenant that
    // reached conflict detection without them is a provisioning bug, and failing the push loudly
    // (rolling it back) beats emitting an unsigned or mis-attributed conflict op.
    throw new Error(
      `tenant ${tenantId} has no system ${user === undefined ? 'actor' : 'device'} (01 §3.6, I-11) — cannot emit a conflict op`,
    );
  }

  return {
    userId: user.id,
    deviceId: device.id,
    publicKey: base64ToBytes(device.signingKeyPublic),
  };
}

export interface ConflictDetectionWiringDeps {
  readonly modules: readonly AnyModuleDefinition<DB>[];
  readonly keyStore: SystemKeyStore;
  readonly crypto: CryptoPort;
  readonly now: () => number;
  readonly newId: () => string;
}

/**
 * Build the production `detectConflicts` closure over an injected key store.
 *
 * Whether to CALL this at all — i.e. whether detection is enabled — is the composition root's
 * decision (`resolveDeps`), keyed on whether a `SystemKeyStore` was injected. When none is, the
 * root leaves `detectConflicts` undefined and the pipeline skips detection (see the file header for
 * why "detect and fail" would be worse). So this function always returns a closure; it is simply
 * not built when no store exists.
 */
export function buildConflictDetection(deps: ConflictDetectionWiringDeps): DetectConflictsFn {
  const registry = buildConflictRegistry(deps.modules);

  const systemIdentity = async (db: TenantDb, tenantId: string): Promise<SystemIdentity> => {
    const signer = await deps.keyStore.getSystemSigner(tenantId);
    if (signer === undefined) {
      // Reached only if the store returned a signer at wiring time (so detection was enabled) but
      // not now — a store whose key set changed under us. Fail the push loudly rather than emit an
      // unsigned op; a conflict that cannot be signed must not be half-recorded (10-db §3 atomic).
      throw new Error(
        `no system signer for tenant ${tenantId} — conflict detection was enabled but the key store produced no key`,
      );
    }
    const dir = await loadSystemDirectory(db, tenantId);
    return {
      systemDeviceId: dir.deviceId,
      systemUserId: dir.userId,
      systemDevicePublicKey: dir.publicKey,
      sign: signer,
    };
  };

  const detectionDeps = {
    crypto: deps.crypto,
    now: deps.now,
    newId: deps.newId,
    registry,
    // v0 registers exactly one Rule-2 check (01 §8.2). Inert until task 25 registers `notes` (its
    // op type is UNKNOWN_TYPE today), but shipped so the check set is COMPLETE from the start.
    invariantChecks: [NOTES_EDIT_AFTER_ARCHIVE],
    systemIdentity,
  };

  return (db, tenantId, accepted) => detectConflicts(db, detectionDeps, tenantId, accepted);
}
