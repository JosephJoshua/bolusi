// The SERVER arm of the FR-1045 denial audit trail (security-guide §2.2: the denied-access rule
// table "applies to every endpoint", and its permission row requires "403 PERMISSION_DENIED,
// denial logged"). Task 44 closed the CLIENT arm — the command runtime emits an
// `auth.permission_denied` op. This is the other arm, and it is deliberately a DIFFERENT sink.
//
// WHY identity_audit AND NOT AN OP (02-permissions §7, and §2.8 — no third mechanism):
//   §7's op envelope requires the denial to carry the DEVICE's store ("all auth ops are
//   store-scoped") and to be signed into that device's hash chain, and it names the command
//   RUNTIME as the emitter. Most control-plane denials arrive on a CONTROL SESSION, which has no
//   device and no store, so that envelope is unsatisfiable without fabricating its attribution
//   fields — a false audit record is worse than none — and the server runs no command runtime.
//   Every action denied here is a control-plane / directory action, exactly what identity_audit
//   already covers, so the denied attempt lands beside the successful mutation it was attempting.
//   Consequence, stated so no reader assumes one arm covers the other (T-15): these rows do NOT
//   appear in `auth_permission_denials` / `listPermissionDenials` — that read path is the client
//   arm's. The server's denial trail is `identity_audit`, action `permission.denied`.
//
// The `reason` vocabulary is §7's CLOSED DenialReason set — extending it is a red flag, so this
// module reuses it verbatim rather than inventing server-specific reasons.
import type { ForTenant } from '@bolusi/db-server';

import { ApiError } from '../errors.js';
import { appendAudit } from './audit.js';

/** 02-permissions §7's closed DenialReason set. Not extended — reused. */
export type DenialReason =
  | 'not_granted'
  | 'unknown_permission'
  | 'missing_scope'
  | 'user_inactive'
  | 'tenant_mismatch'
  | 'restriction_violated'
  | 'evaluation_error';

/** The `identity_audit` action / entity_type pair for a denial row (free-text columns, 10-db §7). */
export const DENIAL_ACTION = 'permission.denied';
export const DENIAL_ENTITY_TYPE = 'permission_denial';

/**
 * The audit context a denied handler declares. Request-scoped fields (tenantId, the acted-on
 * target, the device) are NOT here — the single emission point derives them from the request
 * context, so a handler cannot get them wrong or forget them.
 */
export interface DenialContext {
  /** The VALIDATED acting user (requirePermission / handler already resolved it). */
  readonly actorUserId: string | null;
  /** The 02-permissions §11 permission id, or null for a restriction with no single owning id. */
  readonly permissionId: string | null;
  /** The evaluation scope (§5.2); null for a tenant-scoped check or a control session. */
  readonly scopeStoreId: string | null;
  readonly reason: DenialReason;
}

/**
 * A 403 PERMISSION_DENIED that carries its audit context. Handlers *declare* the denial by
 * throwing this; the single emission point (app.ts `onError`) *emits* it — the same
 * declare/emit split 02-permissions §7 specifies for the client arm, so there is exactly one
 * writer rather than a copy per endpoint (§2.8).
 *
 * The context lives on the error object, NOT in `ApiError.details`: details are serialized into
 * the response envelope, and the permission id / reason must never be handed to the caller who
 * was just denied.
 */
export class PermissionDeniedError extends ApiError {
  readonly denial: DenialContext;

  constructor(denial: DenialContext) {
    super('PERMISSION_DENIED');
    this.name = 'PermissionDeniedError';
    this.denial = denial;
  }
}

export interface RecordDenialInput {
  readonly tenantId: string;
  /** The acted-on surface, e.g. `PATCH /v1/tenant/settings` — derived from the request. */
  readonly target: string;
  /** The authenticated device, when the request carried a device token; null on a control session. */
  readonly deviceId: string | null;
  readonly denial: DenialContext;
  /** ms epoch. */
  readonly at: number;
}

/**
 * Append the denial row. Runs in its OWN `forTenant` transaction, which is load-bearing: the
 * denial is thrown INSIDE the request's tenant transaction and that transaction has already
 * ROLLED BACK by the time `onError` runs (identity/errors.ts documents the same rollback property
 * for IdentityError). A row written on the request's own handle would be rolled back with it — the
 * audit trail would be green in code and empty in the table.
 *
 * Never permission-checked, so it cannot re-enter the deny path (§7 "a denial log must not itself
 * be deniable"; the non-recursion constraint).
 */
export async function recordPermissionDenial(
  forTenant: ForTenant,
  input: RecordDenialInput,
): Promise<void> {
  await forTenant(input.tenantId, (db) =>
    appendAudit(db, input.tenantId, {
      actorUserId: input.denial.actorUserId,
      action: DENIAL_ACTION,
      entityType: DENIAL_ENTITY_TYPE,
      // A denial mutates nothing, so there is no entity to point at; the attempt travels in `after`.
      entityId: null,
      after: {
        permissionId: input.denial.permissionId,
        scopeStoreId: input.denial.scopeStoreId,
        target: input.target,
        reason: input.denial.reason,
        deviceId: input.deviceId,
      },
      at: input.at,
    }),
  );
}
