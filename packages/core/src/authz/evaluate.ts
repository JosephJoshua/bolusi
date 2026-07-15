// The evaluation algorithm (02-permissions §5.2, normative) and the closed `DenialReason` set (§7).
//
// THIS FILE IS THE AUTHORIZATION CONTROL. Not the UI, not the route handler, not sync push
// validation — 02 §4: the only control is the command/query runtime's check, and this is what it
// calls. The V2 agent calls commands directly and never sees a button (FR-1028); a hidden button
// that is not also a denied command is not a control at all. Everything above this is convenience.
//
// FAIL CLOSED IS UNCONDITIONAL (§5.2 step 7, §5.3). Every path out of `evaluatePermission` is
// either `{allowed: true}` because a grant was FOUND, or a denial with a reason. There is no path
// that allows by default, no path that throws to the caller, and no path that returns "don't
// know". A `try` wraps the whole body precisely so that a bug — a corrupt row, a bad JSON blob, an
// unexpected null — becomes DENY `evaluation_error` rather than an exception the enforcement point
// might catch and mistake for something recoverable.
//
// Platform-free: imports only sibling authz types (08 §3.3).
import type { DirectorySnapshot } from './directory.js';
import type { PermissionRegistry } from './registry.js';

/**
 * The closed `DenialReason` set (§7). Extending it is a CLAUDE.md §6 red flag — stop and ask.
 *
 * `restriction_violated` is NOT produced by this algorithm: it is the §5.4 handler-level
 * anti-escalation restrictions' reason, raised inside the server identity endpoints (tasks 13) and
 * the offline PIN command handlers (task 14). It lives in this set because the denial op's payload
 * (§7) carries one enum for every denial the system records, whoever raised it.
 */
export const DENIAL_REASONS = [
  'not_granted',
  'unknown_permission',
  'missing_scope',
  'user_inactive',
  'tenant_mismatch',
  'restriction_violated',
  'evaluation_error',
] as const;

export type DenialReason = (typeof DENIAL_REASONS)[number];

/** The §5.2 result shape. A denial is ALWAYS explicit — never an empty result (FR-1036). */
export type PermissionResult =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: DenialReason };

/** The §5.2 signature's arguments. */
export interface PermissionQuery {
  readonly userId: string;
  /** The evaluation tenant (`ctx.tenantId`). */
  readonly tenantId: string;
  /**
   * The evaluation store. **v0 rule (normative, §5.2): this is the enrolled device's store,
   * always.** The runtime stamps it into `ctx` and into every op it appends, so an op's recorded
   * scope always equals the scope it was authorized in. The FR-1034 store switcher is v1.
   */
  readonly storeId: string | null;
  readonly permissionId: string;
}

/**
 * A user's effective permission ids in each scope, for one `(userId, storeId)` (§5.2 steps 4–6).
 *
 * Two sets, not one, because "effective set" is scope-relative: the SAME grant contributes
 * differently depending on which scope the check runs in. Keeping them apart is what makes §5.2
 * step 4's hard rule — "a store-scoped grant can NEVER satisfy a tenant-scoped permission, even if
 * the role's grant list contains it" — a structural property rather than a condition someone has
 * to remember to write.
 */
export interface EffectiveSet {
  /** Ids exercisable in TENANT scope: from tenant-wide grants (`grant.storeId = null`) only. */
  readonly tenantScope: ReadonlySet<string>;
  /** Ids exercisable in STORE scope at this `storeId`: matching-store grants PLUS tenant-wide ones. */
  readonly storeScope: ReadonlySet<string>;
}

const ALLOW: PermissionResult = Object.freeze({ allowed: true });

function deny(reason: DenialReason): PermissionResult {
  return { allowed: false, reason };
}

/**
 * Parse a role's `permission_ids` JSON (10-db §9.5). THROWS on anything that is not a JSON array
 * of strings — the caller turns that into DENY `evaluation_error` (§5.2 step 7). A corrupt grant
 * list must never be silently read as "no permissions" (that is a denial for the wrong reason) nor
 * as a partial list (that is an authorization decision made from garbage).
 */
export function parsePermissionIds(json: string): readonly string[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new TypeError(`roles_directory.permission_ids is not a JSON array: ${json}`);
  }
  for (const id of parsed) {
    if (typeof id !== 'string') {
      throw new TypeError(`roles_directory.permission_ids contains a non-string: ${String(id)}`);
    }
  }
  return parsed as readonly string[];
}

/**
 * §5.2 steps 4–6: collect the user's scope-matching grants, drop the malformed ones, union the
 * survivors' `permissionIds`.
 *
 * May THROW (a corrupt `permission_ids` row) — `evaluatePermission` catches it into
 * `evaluation_error`. Ids are unioned VERBATIM: an id unknown to this build lands in the set and
 * is inert, because step 1 rejects it against the registry before the set is ever consulted (§5.3
 * "grant list contains an id unknown to this build").
 */
export function computeEffectiveSet(
  snapshot: DirectorySnapshot,
  userId: string,
  storeId: string | null,
): EffectiveSet {
  const tenantScope = new Set<string>();
  const storeScope = new Set<string>();

  for (const grant of snapshot.grantsByUser.get(userId) ?? []) {
    const role = snapshot.roles.get(grant.roleId);
    // Step 5: grant references a deleted/unknown role → contributes nothing. PRD-011 §7's
    // dangling-role hazard resolves to NO access here, never to unchecked access.
    if (role === undefined) continue;
    // Step 5: malformed — a store-scoped role REQUIRES a non-null grant.storeId (§5.1). Dropped
    // BEFORE the scope match on purpose: a null storeId is the tenant-wide marker, so a
    // store-scoped role carrying one would otherwise read as "valid in every store" — a malformed
    // row silently widening a grant is precisely the escalation this drop exists to prevent.
    if (role.scopeType === 'store' && grant.storeId === null) continue;

    if (grant.storeId === null) {
      // Tenant-wide grant (on a tenant-scoped role, per the drop above). Step 4: it counts in
      // tenant scope, AND in every store of the tenant (FR-1037: the main owner sees all stores —
      // only their own tenant's).
      for (const id of parsePermissionIds(role.permissionIdsJson)) {
        tenantScope.add(id);
        storeScope.add(id);
      }
    } else if (storeId !== null && grant.storeId === storeId) {
      // Store-scoped grant matching the evaluation store. Step 4: it counts in store scope ONLY —
      // never in tenant scope, whatever its role's grant list contains.
      for (const id of parsePermissionIds(role.permissionIdsJson)) {
        storeScope.add(id);
      }
    }
    // A grant for a DIFFERENT store contributes nothing to either scope.
  }

  return { tenantScope, storeScope };
}

/** Lets the memo (memo.ts) supply a cached `EffectiveSet` instead of recomputing per call. */
export type EffectiveSetLookup = (userId: string, storeId: string | null) => EffectiveSet;

/**
 * `hasPermission` — the normative §5.2 algorithm. Synchronous by contract (§6): it reads the
 * in-memory snapshot and never performs I/O.
 *
 * Step order is load-bearing, and matches §5.2 / the §5.3 table:
 *   1. id resolves in THIS build's registry        → else DENY `unknown_permission`
 *   2. user exists / tenant matches / status active → else DENY `user_inactive` / `tenant_mismatch`
 *   3. store-scoped permission has a storeId        → else DENY `missing_scope`
 *   4-6. scope-matching, non-malformed grant holds the id → ALLOW, else DENY `not_granted`
 *   7. anything threw                               → DENY `evaluation_error`
 */
export function evaluatePermission(
  registry: PermissionRegistry,
  snapshot: DirectorySnapshot,
  query: PermissionQuery,
  effectiveSetFor?: EffectiveSetLookup,
): PermissionResult {
  try {
    // Step 1. An id this build does not know can never be granted — checked FIRST, so an unknown
    // id in some role's grant list can never allow anything (§3.2 version-skew rule).
    const entry = registry.get(query.permissionId);
    if (entry === undefined) return deny('unknown_permission');

    // Step 2. Absent user first: on the client the mirrors carry no tenant column, so "this user's
    // tenant" is the device's tenant — a question only worth asking once the user exists at all.
    const user = snapshot.users.get(query.userId);
    if (user === undefined) return deny('user_inactive');
    if (snapshot.tenantId === null || snapshot.tenantId !== query.tenantId) {
      return deny('tenant_mismatch');
    }
    if (user.status !== 'active') return deny('user_inactive');

    // Step 3. `scope: 'tenant'` IGNORES storeId entirely (§5.2 step 3).
    if (entry.scope === 'store' && (query.storeId === null || query.storeId === undefined)) {
      return deny('missing_scope');
    }

    // Steps 4–6.
    const effective =
      effectiveSetFor === undefined
        ? computeEffectiveSet(snapshot, query.userId, query.storeId)
        : effectiveSetFor(query.userId, query.storeId);
    const granted = entry.scope === 'store' ? effective.storeScope : effective.tenantScope;
    return granted.has(query.permissionId) ? ALLOW : deny('not_granted');
  } catch {
    // Step 7. Fail closed is unconditional: a bug denies, it never throws past the control and it
    // never allows.
    return deny('evaluation_error');
  }
}
