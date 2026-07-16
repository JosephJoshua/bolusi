// The `conflicts` projection (01 §5.4/§7; 03-state-machines §7). ONE applier per op type, run by
// the task-08 engine on BOTH engines (04 §2, T-8) — there is no server copy.
//
// TWO OPS, ONE ENTITY. `platform.conflict_detected` (entityId = a new conflict id) and
// `platform.conflict_acknowledged` (entityId = that conflict id) both carry `entityType: 'conflict'`
// and the same `entityId`. That is what makes the §4.2 re-fold correct here: it deletes the
// conflict's row and re-folds BOTH ops in canonical order, so the acknowledgment is never lost by
// an out-of-order detection op arriving after it.
//
// WHAT THE APPLIER DOES NOT DO. It does not decide WHETHER a conflict exists (that is the server's
// Rule 1/Rule 2 at acceptance — 01 §8.2) and it does not order anything (the engine guarantees
// canonical order, 04 §4.2). It folds a decision already made and signed into a row.
import type { ProjectionApplier, ProjectionTableManifest } from '../../projection/manifest.js';
import { PLATFORM_ENTITY, restingStatusFor } from '../constants.js';
import type { PlatformDatabase } from '../schema.js';

/**
 * `platform.conflict_detected` payload (01 §6).
 *
 * The conflict's own id is NOT here — it is the op's `entityId` (01 §5.4: "id | UUIDv7 | = the
 * `entityId` of the detection op"). Carrying it twice would let the two disagree.
 */
export interface ConflictDetectedPayload {
  readonly entityType: string;
  readonly entityId: string;
  readonly conflictKey: string;
  readonly severity: 'minor' | 'significant';
  readonly opAId: string;
  readonly opBId: string;
}

/** `platform.conflict_acknowledged` payload (01 §6): the owner's decision note, or null. */
export interface ConflictAcknowledgedPayload {
  readonly note: string | null;
}

/**
 * 04 §4.4 table manifest — columns in 10-db DDL order (the oracle digests them in this order).
 *
 * `entityType: 'conflict'` + `entityIdColumn: 'id'` is the (entityType, entityId) → rows mapping
 * the §4.2 re-fold deletes by. Note `id` — the CONFLICT's id — not the `entity_id` column, which
 * holds the id of the *conflicted* entity (a note). Deleting by `entity_id` would wipe every
 * conflict on that note when one of them re-folded.
 */
export const conflictsTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    entity_type: 'text',
    entity_id: 'text',
    conflict_key: 'text',
    severity: 'text',
    status: 'text',
    op_a_id: 'text',
    op_b_id: 'text',
    detected_at: 'integer',
    acknowledged_by: 'text',
    acknowledged_at: 'integer',
    acknowledgement_op_id: 'text',
  },
  primaryKey: ['id'],
  entityType: PLATFORM_ENTITY.conflict,
  entityIdColumn: 'id',
  projectionVersion: 1,
};

/**
 * Fold `platform.conflict_detected` → one `conflicts` row, already classified.
 *
 * THE ROW IS BORN AT ITS RESTING STATUS, never at `detected`. 03 §7: "`detected` is transient:
 * classification happens in the same transaction that creates the record", and 01 §5.4 says the
 * status is "never at rest" as `detected`. Writing `detected` and updating it would make the
 * transient state observable and, on a crash between the two, permanent — which is the very thing
 * §7's re-classification self-loop exists to repair. Deriving it here means the repair is automatic:
 * any re-fold or rebuild of this entity recomputes the resting status from the signed severity.
 */
export const conflictDetectedApplier: ProjectionApplier<PlatformDatabase> = async (db, op) => {
  const payload = op.payload as unknown as ConflictDetectedPayload;
  await db
    .insertInto('conflicts')
    .values({
      id: op.entityId,
      tenantId: op.tenantId,
      // The conflicted entity's store (01 §5.4) — it rides the envelope, because that is what
      // routes the conflict to the right devices via pull scope.
      storeId: op.storeId,
      entityType: payload.entityType,
      entityId: payload.entityId,
      conflictKey: payload.conflictKey,
      severity: payload.severity,
      status: restingStatusFor(payload.severity),
      opAId: payload.opAId,
      opBId: payload.opBId,
      // Server time of detection (01 §5.4). The detection op's own timestamp IS that time — the
      // op is built by the server, at detection, inside the push transaction (10-db §3).
      detectedAt: op.timestamp,
      acknowledgedBy: null,
      acknowledgedAt: null,
      acknowledgementOpId: null,
    })
    .execute();
};

/**
 * Fold `platform.conflict_acknowledged` → `surfaced` becomes `acknowledged` (03 §7).
 *
 * TOTAL BY CONSTRUCTION — the `status = 'surfaced'` predicate is the whole rule, and it discharges
 * three of 03 §7's requirements at once:
 *
 *  - "duplicate acknowledgments merged from two devices — first in canonical order wins; later ones
 *    fold as no-ops, and are not themselves conflicts": the first ack finds `surfaced` and takes it
 *    to `acknowledged`; the second finds `acknowledged`, matches no row, and writes nothing. The
 *    engine feeds them in canonical order, so "first" is deterministic on every device.
 *  - an ack folded against an `auto_resolved` conflict is likewise a no-op (a minor conflict is
 *    terminal, 01 §8.3). The COMMAND rejects that attempt with `INVALID_TRANSITION`; the applier
 *    still must not corrupt the row if such an op exists in a log (05 §7: old ops never disappear).
 *  - a conflict row that does not exist yet (the ack folded before its detection op) matches
 *    nothing — and the engine's §4.2 re-fold then replays both in canonical order.
 *
 * An `UPDATE … WHERE status = 'surfaced'` that matches nothing is a SUCCESSFUL no-op on both
 * engines — not an error — which is exactly the "appliers are total" property 03 §11 names.
 */
export const conflictAcknowledgedApplier: ProjectionApplier<PlatformDatabase> = async (db, op) => {
  await db
    .updateTable('conflicts')
    .set({
      status: 'acknowledged',
      acknowledgedBy: op.userId,
      acknowledgedAt: op.timestamp,
      acknowledgementOpId: op.id,
    })
    .where('id', '=', op.entityId)
    .where('status', '=', 'surfaced')
    .execute();
};
