// Scope validation (05 §9, api/02-auth §6.3). Fail closed — accept only if every rule holds.
// SCOPE_VIOLATION is the single code for the whole set (05 §8 gains no new code); the `reason`
// distinguishes them for the anomaly detail + operator debugging.
//
// Device binding is checked SEPARATELY and EARLIER by the orchestrator (before signature) so an
// op signed by its real device but pushed via another device's token attributes as SCOPE_VIOLATION
// rather than BAD_SIGNATURE. This module carries the rest: tenant/store/user consistency,
// membership-not-status, the media-ref → envelope binding (task 140 Leg B), and the per-type
// extension rules.
import type { TenantDb } from '@bolusi/db-server';
import type { SignedOperation } from '@bolusi/schemas';

import { mayManageOwnerPin } from '../../auth/permissions.js';
import type { DeviceRecord, OpRegistry } from '../types.js';

/** The per-type extension list (05 §9.5) — spec-fixed op-type strings. Permissions are not checked
 *  here: every type's declared permission is the authorization step's (steps/permission.ts). */
export const GENESIS_TYPE = 'auth.device_enrolled';
export const AUTH_PIN_CHANGED = 'auth.pin_changed';
export const AUTH_DEVICE_CHANGES_TRANSFERRED = 'auth.device_changes_transferred';
export const AUTH_PIN_RESET = 'auth.pin_reset';
export const AUTH_PIN_LOCKOUT_CLEARED = 'auth.pin_lockout_cleared';
export const PLATFORM_CONFLICT_DETECTED = 'platform.conflict_detected';
export const PLATFORM_CONFLICT_ACKNOWLEDGED = 'platform.conflict_acknowledged';

/** A refusal; `tamper: false` marks one an honest device can meet (a stale directory), which is
 *  refused without recording a device anomaly. */
export type ScopeOutcome = null | { readonly reason: string; readonly tamper?: false };

type MediaRefLike = { readonly userId?: unknown; readonly deviceId?: unknown };

/**
 * Every object in `payload` shaped like a media ref (it carries a `mediaId`), at any depth and in
 * arrays. Shape-based rather than per-type paths, so a new op type's refs are bound the moment it
 * declares them. Payload size is capped at the push boundary, which bounds the walk.
 */
function mediaRefsIn(payload: unknown): MediaRefLike[] {
  const found: MediaRefLike[] = [];
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if ('mediaId' in value) found.push(value as MediaRefLike);
    for (const child of Object.values(value)) visit(child);
  };
  visit(payload);
  return found;
}

/** The directory reads the scope step needs, each made once per push batch. */
export interface ScopeLookup {
  storeExists(storeId: string): Promise<boolean>;
  userExists(userId: string): Promise<boolean>;
  /** May the actor reset or unlock the target's PIN as far as owner powers go (auth/permissions). */
  mayManageOwnerPin(actorUserId: string, targetUserId: string): Promise<boolean>;
}

/**
 * Memoizes the scope step's reads for one push transaction. A batch is one device's ops, nearly
 * always one store and one author, so this turns per-op reads into one per batch. Lives only for one
 * transaction, so a directory change between pushes is always seen.
 */
export function createScopeLookup(db: TenantDb, tenantId: string): ScopeLookup {
  const cache = new Map<string, Promise<boolean>>();
  const once = (key: string, load: () => Promise<unknown>) => {
    let value = cache.get(key);
    if (value === undefined) {
      value = load().then((row) => row !== undefined && row !== false);
      cache.set(key, value);
    }
    return value;
  };
  return {
    storeExists: (storeId) =>
      once(`store:${storeId}`, () =>
        db.selectFrom('stores').select('id').where('id', '=', storeId).executeTakeFirst(),
      ),
    userExists: (userId) =>
      once(`user:${userId}`, () =>
        db.selectFrom('users').select('id').where('id', '=', userId).executeTakeFirst(),
      ),
    mayManageOwnerPin: (actorUserId, targetUserId) =>
      once(`ownerPin:${actorUserId}:${targetUserId}`, () =>
        mayManageOwnerPin(db, tenantId, actorUserId, targetUserId),
      ),
  };
}

/**
 * Validate scope for a chain-valid, signature-valid op. All lookups run under RLS (tenant-bound
 * handle), so a store/user id belonging to another tenant is simply invisible → not found →
 * SCOPE_VIOLATION.
 */
export async function checkScope(
  lookup: ScopeLookup,
  op: SignedOperation,
  device: DeviceRecord,
  registry: OpRegistry,
): Promise<ScopeOutcome> {
  // §9.2: op tenant == device tenant.
  if (op.tenantId !== device.tenantId) {
    return { reason: 'op tenantId does not match the device tenant' };
  }

  // §9.2: op store is null (tenant-scoped) or a store of the tenant.
  if (op.storeId !== null) {
    if (!(await lookup.storeExists(op.storeId))) {
      return { reason: 'op storeId is not a store of the tenant' };
    }
  }

  // §9.2 (D22, task 157) LEG 1 — a STORE-scoped op TYPE must carry a store. An op whose declared
  // type is store-scoped (01 §6; `OperationDeclaration.scope`, default `'store'`) but whose envelope
  // `storeId` is null is MALFORMED, and it is the dodge that makes the equality rule below
  // bypassable: that rule can only fire on a NON-null store, so `storeId = null` slipped past it
  // while the mutation appliers — which resolve their target row from `entityId`, not from
  // `op.storeId` — happily wrote into ANOTHER store (`notes` RLS is tenant-only). Worse, a null
  // store widens PULL scope (`storeId = device.storeId OR storeId IS NULL`, api/01-sync §4.1), so
  // every device in the victim store re-folds the forgery locally. Rejected here as SCOPE_VIOLATION
  // rather than SCHEMA_INVALID because `storeId` is an ENVELOPE field and §9 owns envelope
  // tenant/store/user consistency; §8's SCHEMA_INVALID is the PAYLOAD verdict and never inspects it.
  //
  // The scope is READ FROM THE DECLARING MODULE, never hardcoded here: a new store-scoped op type is
  // covered the moment it is declared, and a genuinely tenant-scoped type must say so. That is what
  // keeps `platform.user_locale_changed` — tenant-scoped, `storeId` legitimately null, the
  // preference follows the user to every device (01 §6) — accepted by this very rule.
  //
  // An UNKNOWN type resolves `undefined` and is deliberately left alone: the schema step answers it
  // as `UNKNOWN_TYPE` (05 §8), and rejecting it here would mis-attribute it to scope.
  if (registry.scopeOf(op.type) === 'store' && op.storeId === null) {
    return { reason: 'a store-scoped op type must carry a storeId, not null' };
  }

  // §9.2 (D22, task 157): a device may write ONLY its OWN store's ops — closing the gap where a
  // device at store A could write an op INTO store B of the same tenant (a mechanic recording a
  // repair note in another branch's book). Reject a NON-NULL `storeId` that is a store of the
  // tenant OTHER than the pushing device's own store. This is ADDITIONAL to the tenant/store checks
  // above and to RLS — a narrower scope, never a replacement.
  //
  // A TENANT-scoped op (`storeId = null`) is NOT a cross-store write and passes: a MEMBER device
  // legitimately emits `platform.user_locale_changed` (tenant-scoped, 01 §6). Member devices always
  // carry a `store_id` (10-db §4 CHECK `kind = 'system' OR store_id IS NOT NULL`), and the runtime
  // stamps that store into every STORE-scoped op it appends (02-permissions §5.2), so for those
  // `op.storeId == device.storeId`.
  //
  // WHY NO SYSTEM-DEVICE BRANCH — and it is NOT because a store-less device "has no store to be
  // constrained to". That reasoning would be false: the tenant system device's only op,
  // `platform.conflict_detected`, carries a NON-null `storeId` (the conflicted entity's store —
  // sync/conflict-detection.ts), so this rule WOULD reject it if it ever reached here. The carve-out
  // rests ENTIRELY on the fact that it never does: system ops are built by `appendSystemOp`, which
  // INSERTs straight through `insertOperationRow` inside the push transaction and never calls
  // `checkScope` (01 §3.6 — "no carve-outs to §9's scope checks"; there is no push path for the
  // system device, whose key is server-held). If a refactor ever routes system ops through this
  // step, conflict detection breaks HERE — that is the intended tripwire, and this comment is the
  // notice, not a claim that the case is impossible.
  if (op.storeId !== null && op.storeId !== device.storeId) {
    return {
      reason: "op storeId is a store of the tenant other than the pushing device's own store",
    };
  }

  // §9.3: op userId is a MEMBER of the tenant directory. Membership only: an author deactivated
  // while the device was offline is the authorization step's refusal (owner decision 2026-10-26),
  // not a scope violation, so it raises no tamper alarm.
  if (!(await lookup.userExists(op.userId))) {
    return { reason: 'op userId is not a member of the tenant directory' };
  }

  // §9 media-ref binding (task 140 Leg B; 06 §3.2). A payload's `mediaRef` is self-describing: it
  // carries its OWN `userId`/`deviceId` (06 §3.2 — "capture and attach happen in one command", so
  // in v0 they duplicate the envelope). Bind them to the ENVELOPE's authenticated signer, exactly
  // as §9.1 binds the op `deviceId` to the token device. Without this a device signs a note whose
  // ref names ANOTHER device's `mediaId`, and a puller renders that device's photo as this note's
  // evidence with zero verification (task 140's composed evidence-substitution attack). Universal,
  // not per-type: the ref is the shared `zMediaRef` fragment (06 §3.2, defined once — CLAUDE.md
  // §2.8), so ANY op carrying one at `payload.mediaRef` is bound here, not just `notes.note_created`.
  //
  // This runs BEFORE the schema step (pipeline step 6, SCHEMA_INVALID), so guard the comparison: a
  // STRUCTURALLY-VALID ref whose id is a string that mismatches is a binding violation
  // (SCOPE_VIOLATION); a structurally-malformed ref (absent/non-string id, or a `mediaRef` that is
  // not an object) is LEFT for the schema step — we compare only when the id is present as a string,
  // so a malformed payload is never mis-attributed to scope, and 127's per-version schema gate is
  // not weakened. A null `mediaRef` (no photo, 05 §3) has nothing to bind and is skipped.
  //
  // WHAT IS NOT CHECKED HERE, and cannot be: media EXISTENCE/ownership of `mediaId`. The op syncs
  // independently of the file and the server never cross-validates a push against `media` rows
  // (api/03 §1, 06 §4, FR-1138) — the referenced media may not have been uploaded (or `init`-ed)
  // yet. So this binds the SIGNER; `mediaId` existence stays defended downstream by download scope
  // (api/03 §2) + the client's `sha256` pre-display check (task 140 Leg A). Residual in task 140.
  //
  // EVERY ref in the payload is bound, wherever it sits: repair ops carry them at
  // `photos.front`…, `handoverPhoto`, `signature` and in arrays, and a ref the walk skipped would let
  // a device cite a colleague's capture as its own evidence.
  for (const ref of mediaRefsIn(op.payload)) {
    if (typeof ref.deviceId === 'string' && ref.deviceId !== op.deviceId) {
      return { reason: 'a media ref deviceId does not match the envelope device' };
    }
    if (typeof ref.userId === 'string' && ref.userId !== op.userId) {
      return { reason: 'a media ref userId does not match the envelope user' };
    }
  }

  // §9.5 per-type extension rules.
  switch (op.type) {
    case GENESIS_TYPE:
      // Genesis structural: seq 1, entityId == the device's own id.
      if (op.seq !== 1 || op.entityId !== op.deviceId) {
        return {
          reason: 'auth.device_enrolled must be the device genesis (seq 1, entityId = deviceId)',
        };
      }
      return null;

    case AUTH_DEVICE_CHANGES_TRANSFERRED: {
      // A re-enrolled phone's audit record: about the device that signs it, moving changes from
      // OTHER registrations. The server may never have known those (that is why the phone
      // re-enrolled), so it cannot check them further; each carried change is checked on its own.
      const from = (op.payload as { fromDeviceIds?: unknown }).fromDeviceIds;
      if (op.entityId !== op.deviceId || (Array.isArray(from) && from.includes(op.deviceId))) {
        return {
          reason: `${op.type} must name the signing device and move changes from other devices`,
        };
      }
      return null;
    }

    case AUTH_PIN_CHANGED:
      // Self only: envelope userId == entityId (target).
      if (op.userId !== op.entityId) {
        return { reason: 'auth.pin_changed may only target the acting user (userId == entityId)' };
      }
      return null;

    case AUTH_PIN_RESET:
    case AUTH_PIN_LOCKOUT_CLEARED: {
      // An owner's PIN is the main owner's to manage (owner powers): blocks a store owner taking
      // over the main owner or a peer owner, api/02-auth §6.6; unlocking an owner's PIN is the
      // same takeover's first step. The permission itself is the authorization step's.
      // Not tamper: the device judged from its bundle, and someone made an owner since it last
      // synced is an owner here too.
      if (!(await lookup.mayManageOwnerPin(op.userId, op.entityId))) {
        return {
          reason: `${op.type} on an owner requires the actor to be the main owner`,
          tamper: false,
        };
      }
      return null;
    }

    case PLATFORM_CONFLICT_DETECTED:
      // Only a tenant SYSTEM device may emit conflict_detected; it is server-built (appendSystemOp),
      // never pushed by a member device.
      if (device.kind !== 'system') {
        return {
          reason: 'platform.conflict_detected may only originate from the tenant system device',
        };
      }
      return null;

    case PLATFORM_CONFLICT_ACKNOWLEDGED:
      // Member devices acknowledge; no extra structural rule here (permission is command-side).
      return null;

    default:
      return null;
  }
}
