// The `auth_sessions` projection (api/02-auth §6.2/§6.3; the PRD-011 §5 UserSession record).
//
// TWO OPS, ONE ENTITY. `auth.user_switched` (entityId = a new session UUIDv7) INSERTS the open
// session; `auth.session_ended` (entityId = that same session id) closes it by setting `ended_at` +
// `end_reason`. Both carry `entityType: 'auth_session'` and the SAME `entityId`, which is what makes
// the §4.2 re-fold correct: it deletes the session's row by `id` and re-folds BOTH ops in canonical
// order (05 §4 — timestamp,deviceId,seq), so an out-of-order `session_ended` arriving before its
// `user_switched` never lands a close on a row that does not exist yet.
//
// WHAT THESE APPLIERS DO NOT DO. They do not order anything (the engine guarantees canonical order,
// 04 §4.2 — "appliers never see out-of-order input"), and they run no clock (04 §4.1). They fold a
// signed, already-decided fact into a row, on BOTH engines (04 §2, T-8) — there is no server copy.
import type { ProjectionApplier, ProjectionTableManifest } from '../../projection/manifest.js';
import { AUTH_ENTITY } from '../operations.js';
import type { AuthDatabase, AuthSessionsTable } from '../schema.js';

/**
 * `auth.user_switched` payload (api/02-auth §6.2).
 *
 * Present-and-null, never absent (05 §3's absent-vs-null rule): the FIRST switch on a device has no
 * previous session, and both fields are `null` — the keys are still there, so an old op is never
 * ambiguous about whether "no previous session" was recorded or the field predates the schema.
 */
export interface UserSwitchedPayload {
  readonly previousSessionId: string | null;
  readonly previousUserId: string | null;
}

/** `auth.session_ended` payload (api/02-auth §6.2). */
export interface SessionEndedPayload {
  readonly reason: 'switch' | 'idle_lock' | 'manual_lock';
}

/**
 * 04 §4.4 table manifest — columns in 10-db §549+ DDL order (the oracle digests them in this order).
 *
 * `entityType: 'auth_session'` + `entityIdColumn: 'id'` is the `(entityType, entityId) → rows`
 * mapping the §4.2 re-fold deletes by. `id` IS the `entityId` here (the session's own id), so the
 * delete is honest and precise — it removes exactly this session's row before the two ops re-fold.
 */
export const authSessionsTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    user_id: 'text',
    device_id: 'text',
    started_at: 'integer',
    ended_at: 'integer',
    end_reason: 'text',
  },
  primaryKey: ['id'],
  entityType: AUTH_ENTITY.authSession,
  entityIdColumn: 'id',
  projectionVersion: 1,
};

/**
 * Fold `auth.user_switched` → one open `auth_sessions` row.
 *
 * The row is BORN OPEN: `ended_at`/`end_reason` are null until a `session_ended` closes it. Envelope
 * `userId` is the INCOMING user (api/02-auth §6.3 — "B's switch is what ended A's session"), so
 * `user_id` is the session's user, not whoever it replaced. The payload's `previousUserId` is
 * historical context, not this row's owner.
 */
export const userSwitchedApplier: ProjectionApplier<AuthDatabase> = async (db, op) => {
  const row: AuthSessionsTable = {
    id: op.entityId,
    tenantId: op.tenantId,
    storeId: op.storeId,
    userId: op.userId,
    deviceId: op.deviceId,
    startedAt: op.timestamp,
    endedAt: null,
    endReason: null,
  };
  await db.insertInto('authSessions').values(row).execute();
};

/**
 * Fold `auth.session_ended` → set `ended_at` + `end_reason` on the session's own row.
 *
 * TOTAL BY CONSTRUCTION. An `UPDATE … WHERE id = entityId` that matches nothing is a SUCCESSFUL
 * no-op on both engines, not an error (03 §11 — appliers are total): a `session_ended` that sorts
 * before its `user_switched` matches no row here, and the engine's §4.2 re-fold then replays both in
 * canonical order (insert-then-close). Folding the same op twice writes the same two columns — the
 * update is idempotent, which is what the re-fold and any rebuild rely on.
 */
export const sessionEndedApplier: ProjectionApplier<AuthDatabase> = async (db, op) => {
  const payload = op.payload as unknown as SessionEndedPayload;
  await db
    .updateTable('authSessions')
    .set({ endedAt: op.timestamp, endReason: payload.reason })
    .where('id', '=', op.entityId)
    .execute();
};
