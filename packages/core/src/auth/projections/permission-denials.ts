// The `auth_permission_denials` projection (02-permissions §7) — the FR-1045 audit trail, and the
// load-bearing applier this task exists to close: task 09 built the evaluator to emit a denial op on
// every denial, task 10 made the deny unconditional on the audit succeeding, and all of it landed in
// an op log NOTHING read back until this fold existed.
//
// ONE OP, ONE ENTITY, ONE ROW. 02 §7: `permission_denial` / "fresh UUIDv7 per op … applier inserts
// exactly one row". Each denial is its own single-op entity, so a plain INSERT is total and correct.
//
// SUPPRESSED REPEATS ARE NOT LOST. The §7 throttle emits at most one denial op per
// `(userId, permissionId, target)` per 5-minute window per device; repeats increment an in-memory
// counter FLUSHED into the next emitted op's `suppressedRepeats`. The applier's job is only to
// preserve that count — a suppressed repeat is visible AS a count on the next row, never a vanished
// attempt. The throttle is the emitter's (authz/denials.ts); this fold trusts the signed payload.
import { z } from 'zod';

import { DENIAL_REASONS } from '../../authz/evaluate.js';
import type { ProjectionApplier, ProjectionTableManifest } from '../../projection/manifest.js';
import { AUTH_ENTITY } from '../operations.js';
import type { AuthDatabase, AuthPermissionDenialsTable } from '../schema.js';

/**
 * The `auth.permission_denied` op-payload schema (02-permissions §7 owns the shape; api/02-auth §6.2
 * references it). `.strict()` per 04 §3 — an unknown key is rejected, because a client believing it
 * recorded a field the append-only log does not contain is a silent corruption of the audit.
 *
 * `reason` is `z.enum(DENIAL_REASONS)` — the SAME closed set the evaluator raises (authz/evaluate.ts),
 * imported rather than re-listed so the op schema and the evaluator cannot disagree about which
 * reasons exist (CLAUDE.md §2.8). `scopeStoreId` is `.nullable()` (present-and-null, never absent):
 * null means the check was tenant-scoped, distinct from the envelope's device `storeId`.
 *
 * ON THE DUPLICATE (flagged, not fixed here): `authz/denials.ts` carries `isPermissionDeniedPayload`,
 * a hand-rolled structural predicate written when "no task owned the auth op registry" — its own
 * header says it "should be deleted in favour of [the Zod schema], not kept alongside" once that task
 * lands. This is that schema. Removing the predicate + repointing task 09's tests is an authz-package
 * change (contended, task 45's "auth/core cleanups" surface); filed as a finding, not done here, to
 * keep task 43 to its slice. Both consume `DENIAL_REASONS`, so there is no second reason list.
 */
export const permissionDeniedPayload = z
  .object({
    permissionId: z.string().min(1),
    surface: z.enum(['command', 'query']),
    /** The denied command/query name (02-permissions §7). */
    target: z.string(),
    reason: z.enum(DENIAL_REASONS),
    scopeStoreId: z.string().nullable(),
    suppressedRepeats: z.number().int().min(0),
  })
  .strict();

// NOT exported: `authz/denials.ts` already exports a `PermissionDeniedPayload` interface (task 09),
// and two `export *`d names of the same identifier collide into an unusable barrel export. This is
// the local view the applier casts to; the shape is asserted structurally by `permissionDeniedPayload`
// above. (The consolidation of the two — this Zod schema replacing denials.ts's hand-rolled
// `isPermissionDeniedPayload` — is the flagged task-45 follow-up; see the schema's header.)
type PermissionDeniedPayload = z.infer<typeof permissionDeniedPayload>;

/**
 * 04 §4.4 table manifest — columns in 10-db §549+ DDL order (the oracle's digest order).
 *
 * `entityIdColumn: 'id'` where `id` holds the op's `entityId` (see the applier). Each denial is a
 * single-op entity, so a re-fold of one never fires in practice (there is no newer op for its
 * `entityId`) and a rebuild truncates the table wholesale — but the column is still an HONEST
 * `entityIdColumn`: were a re-fold ever triggered, `DELETE … WHERE id = op.entityId` matches exactly
 * this denial's row. Storing `op.id` here instead would make that delete match nothing — a latent
 * duplicate-on-refold bug, inert only by luck — which is the trap this repo keeps re-shipping.
 */
export const authPermissionDenialsTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    scope_store_id: 'text',
    user_id: 'text',
    device_id: 'text',
    timestamp_ms: 'integer',
    permission_id: 'text',
    surface: 'text',
    target: 'text',
    reason: 'text',
    suppressed_repeats: 'integer',
  },
  primaryKey: ['id'],
  entityType: AUTH_ENTITY.permissionDenial,
  entityIdColumn: 'id',
  projectionVersion: 1,
};

/**
 * Fold `auth.permission_denied` → one `auth_permission_denials` row.
 *
 * `id = op.entityId` (the denial's identity, 02 §7 — see the table manifest for why not `op.id`).
 * `store_id` is the envelope's device store; `scope_store_id` is the EVALUATION scope from the
 * payload (null = tenant-scope check) — two distinct stores 02 §7 is explicit about keeping apart.
 * `user_id`/`device_id` are the envelope's attribution of who was denied, on which device.
 */
export const permissionDeniedApplier: ProjectionApplier<AuthDatabase> = async (db, op) => {
  const payload = op.payload as unknown as PermissionDeniedPayload;
  const row: AuthPermissionDenialsTable = {
    id: op.entityId,
    tenantId: op.tenantId,
    storeId: op.storeId,
    scopeStoreId: payload.scopeStoreId,
    userId: op.userId,
    deviceId: op.deviceId,
    timestampMs: op.timestamp,
    permissionId: payload.permissionId,
    surface: payload.surface,
    target: payload.target,
    reason: payload.reason,
    suppressedRepeats: payload.suppressedRepeats,
  };
  await db.insertInto('authPermissionDenials').values(row).execute();
};
