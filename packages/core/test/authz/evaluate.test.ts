// The fail-closed matrix (02-permissions §5.3) and the scope algorithm (§5.2) — this surface's
// adversarial suite (task 09; CLAUDE.md §2.5: it ships BEFORE review, not after it).
//
// Two disciplines shape every test here:
//
//  T-12 (test the CLASS, not the instances you thought of). The deny-trigger class is §5.3's
//  table, so the matrix below IS that table, row for row, and a denominator test asserts it covers
//  every `DenialReason` the §5.2 algorithm can produce. Three hand-picked denials would prove
//  nothing about the fourth.
//
//  T-14b (an empty result and a correct result look identical). Every deny case first runs a
//  POSITIVE CONTROL — the same fixture with the single deny-trigger removed — and asserts it
//  ALLOWS. Without that, a typo'd user id or an empty grants map would deny for the wrong reason
//  and the suite would call it fail-closed. The control is what proves the trigger is the cause.
import { describe, expect, test } from 'vitest';

import {
  assemblePermissionRegistry,
  computeEffectiveSet,
  DENIAL_REASONS,
  evaluatePermission,
  type DenialReason,
  type DirectorySnapshot,
  type PermissionQuery,
} from '../../src/index.js';
import {
  MATRIX_COUNTS,
  MAIN_OWNER_IDS,
  OTHER_TENANT,
  ROLE_MAIN_OWNER,
  ROLE_STAFF,
  ROLE_STORE_OWNER,
  role,
  snapshot,
  STAFF_IDS,
  STORE_A,
  STORE_B,
  STORE_OWNER_IDS,
  TENANT,
  USER_OWNER,
  USER_STAFF,
  USER_STORE_OWNER,
  USER_ZERO_GRANTS,
  V0_MODULES,
  v0Snapshot,
} from './_fixtures.js';

const registry = assemblePermissionRegistry(V0_MODULES);

/** The baseline query: staff, at the store they are granted in, for a permission staff holds. */
function staffQuery(overrides: Partial<PermissionQuery> = {}): PermissionQuery {
  return {
    userId: USER_STAFF,
    tenantId: TENANT,
    storeId: STORE_A,
    permissionId: 'notes.create',
    ...overrides,
  };
}

function evaluate(snap: DirectorySnapshot, query: PermissionQuery) {
  return evaluatePermission(registry, snap, query);
}

const ALLOWED = { allowed: true } as const;
const denied = (reason: DenialReason) => ({ allowed: false, reason }) as const;

interface Scenario {
  readonly snapshot: DirectorySnapshot;
  readonly query: PermissionQuery;
}

interface FailClosedCase {
  /** The §5.3 condition, in the doc's words. */
  readonly condition: string;
  readonly reason: DenialReason;
  /** The same fixture WITHOUT the deny-trigger — must ALLOW (T-14b). */
  readonly control: () => Scenario;
  /** The fixture WITH the deny-trigger — must DENY with `reason`. */
  readonly deny: () => Scenario;
}

/**
 * §5.3, row for row. Each `control` differs from its `deny` by exactly ONE thing: the trigger.
 */
const FAIL_CLOSED_MATRIX: readonly FailClosedCase[] = [
  {
    condition: 'permission id not in this build’s registry',
    reason: 'unknown_permission',
    // The role's grant list even CONTAINS the id — a permission this build never registered can
    // still never be granted (§3.2 version-skew rule; §5.3 "grant list contains an id unknown to
    // this build" → inert).
    control: () => ({
      snapshot: v0Snapshot({
        roles: {
          [ROLE_STAFF]: role('store', [...STAFF_IDS, 'ghost.permission']),
        },
      }),
      query: staffQuery({ permissionId: 'notes.create' }),
    }),
    deny: () => ({
      snapshot: v0Snapshot({
        roles: {
          [ROLE_STAFF]: role('store', [...STAFF_IDS, 'ghost.permission']),
        },
      }),
      query: staffQuery({ permissionId: 'ghost.permission' }),
    }),
  },
  {
    condition: 'acting user absent from users_directory',
    reason: 'user_inactive',
    control: () => ({ snapshot: v0Snapshot(), query: staffQuery() }),
    deny: () => ({ snapshot: v0Snapshot(), query: staffQuery({ userId: 'user-never-enrolled' }) }),
  },
  {
    condition: "user.status !== 'active'",
    reason: 'user_inactive',
    control: () => ({ snapshot: v0Snapshot(), query: staffQuery() }),
    deny: () => ({
      snapshot: v0Snapshot({
        users: {
          [USER_OWNER]: { status: 'active' },
          [USER_STORE_OWNER]: { status: 'active' },
          [USER_STAFF]: { status: 'deactivated' },
          [USER_ZERO_GRANTS]: { status: 'active' },
        },
      }),
      query: staffQuery(),
    }),
  },
  {
    condition: 'user’s tenant ≠ evaluation tenant',
    reason: 'tenant_mismatch',
    control: () => ({ snapshot: v0Snapshot(), query: staffQuery({ tenantId: TENANT }) }),
    deny: () => ({ snapshot: v0Snapshot(), query: staffQuery({ tenantId: OTHER_TENANT }) }),
  },
  {
    condition: 'store-scoped permission, storeId null/absent',
    reason: 'missing_scope',
    control: () => ({ snapshot: v0Snapshot(), query: staffQuery({ storeId: STORE_A }) }),
    deny: () => ({ snapshot: v0Snapshot(), query: staffQuery({ storeId: null }) }),
  },
  {
    condition: 'grant references a deleted/unknown role',
    reason: 'not_granted',
    control: () => ({ snapshot: v0Snapshot(), query: staffQuery() }),
    // The grant survives the role's deletion — the dangling reference PRD-011 §7 warns about. It
    // must resolve to NO access, never to unchecked access.
    deny: () => ({
      snapshot: v0Snapshot({
        roles: {
          [ROLE_MAIN_OWNER]: role('tenant', MAIN_OWNER_IDS),
          [ROLE_STORE_OWNER]: role('store', STORE_OWNER_IDS),
          // ROLE_STAFF deleted from the directory; USER_STAFF's grant still points at it.
        },
      }),
      query: staffQuery(),
    }),
  },
  {
    condition: 'no matching grant’s role contains the id',
    reason: 'not_granted',
    control: () => ({
      snapshot: v0Snapshot(),
      query: staffQuery({ permissionId: 'notes.create' }),
    }),
    // §12's built-in denial fixture: staff attempting an administrative auth.* permission.
    deny: () => ({
      snapshot: v0Snapshot(),
      query: staffQuery({ permissionId: 'auth.user_create' }),
    }),
  },
  {
    condition: 'evaluator throws (corrupt permission_ids row)',
    reason: 'evaluation_error',
    control: () => ({ snapshot: v0Snapshot(), query: staffQuery() }),
    deny: () => ({
      snapshot: v0Snapshot({
        roles: {
          [ROLE_MAIN_OWNER]: role('tenant', MAIN_OWNER_IDS),
          [ROLE_STORE_OWNER]: role('store', STORE_OWNER_IDS),
          [ROLE_STAFF]: { scopeType: 'store', permissionIdsJson: '["notes.create"' },
        },
      }),
      query: staffQuery(),
    }),
  },
];

describe('fail-closed matrix (02-permissions §5.3)', () => {
  // T-14: the matrix must state — and check — its own denominator. A suite that silently covered
  // four of seven reasons would otherwise be green about the wrong question.
  test('covers every DenialReason the §5.2 algorithm can produce (denominator)', () => {
    const covered = [...new Set(FAIL_CLOSED_MATRIX.map((c) => c.reason))].sort();
    // `restriction_violated` is §5.4 handler-level (the identity endpoints, tasks 13; the offline
    // PIN handlers, task 14) — in the closed enum, but NOT producible by this algorithm.
    const producible = DENIAL_REASONS.filter((r) => r !== 'restriction_violated').sort();
    expect(covered).toEqual([...producible]);
    expect(FAIL_CLOSED_MATRIX.length).toBeGreaterThanOrEqual(producible.length);
  });

  test('restriction_violated is in the closed set but is never produced by the evaluator (§5.4)', () => {
    expect(DENIAL_REASONS).toContain('restriction_violated');
    const reasons = new Set<string>();
    for (const testCase of FAIL_CLOSED_MATRIX) {
      const { snapshot: snap, query } = testCase.deny();
      const result = evaluate(snap, query);
      if (!result.allowed) reasons.add(result.reason);
    }
    expect(reasons.has('restriction_violated')).toBe(false);
  });

  for (const testCase of FAIL_CLOSED_MATRIX) {
    test(`${testCase.condition} → DENY ${testCase.reason}`, () => {
      // T-14b: prove the fixture GRANTS before believing that it denies — otherwise a broken
      // fixture (wrong user id, empty grant map) denies for a reason the test never checked.
      const control = testCase.control();
      expect(evaluate(control.snapshot, control.query)).toEqual(ALLOWED);

      const scenario = testCase.deny();
      expect(evaluate(scenario.snapshot, scenario.query)).toEqual(denied(testCase.reason));
    });
  }

  test('an unknown id in a role’s grant list is inert — the rest of the role is unaffected (§5.3)', () => {
    const snap = v0Snapshot({
      roles: { [ROLE_STAFF]: role('store', [...STAFF_IDS, 'ghost.permission', 'notes.telepathy']) },
    });
    // Inert: cannot allow anything.
    expect(evaluate(snap, staffQuery({ permissionId: 'ghost.permission' }))).toEqual(
      denied('unknown_permission'),
    );
    // Rest of the role unaffected.
    for (const id of STAFF_IDS) {
      expect(evaluate(snap, staffQuery({ permissionId: id })), id).toEqual(ALLOWED);
    }
  });

  test('the evaluator never throws — a corrupt snapshot denies, it does not raise (§5.2 step 7)', () => {
    const corrupt = v0Snapshot({
      roles: { [ROLE_STAFF]: { scopeType: 'store', permissionIdsJson: '{"not":"an array"}' } },
    });
    expect(() => evaluate(corrupt, staffQuery())).not.toThrow();
    expect(evaluate(corrupt, staffQuery())).toEqual(denied('evaluation_error'));
  });

  test('a permission_ids array holding a non-string is corrupt, not partially honoured', () => {
    const corrupt = v0Snapshot({
      roles: {
        [ROLE_STAFF]: { scopeType: 'store', permissionIdsJson: '["notes.create", 42]' },
      },
    });
    expect(evaluate(corrupt, staffQuery())).toEqual(denied('evaluation_error'));
  });

  test('an unbootstrapped device (no meta_kv tenant) denies every check (§5.3)', () => {
    const snap = v0Snapshot({ tenantId: null });
    expect(evaluate(snap, staffQuery())).toEqual(denied('tenant_mismatch'));
  });
});

describe('scope evaluation (02-permissions §5.2 step 4)', () => {
  test('a tenant-scoped permission is satisfied ONLY by a tenant-wide grant', () => {
    const snap = v0Snapshot();
    // main_owner holds auth.role_manage through a storeId=null grant.
    expect(
      evaluate(snap, {
        userId: USER_OWNER,
        tenantId: TENANT,
        storeId: STORE_A,
        permissionId: 'auth.role_manage',
      }),
    ).toEqual(ALLOWED);
  });

  test('a store-scoped grant NEVER satisfies a tenant-scoped permission, even when the role lists it', () => {
    // A store-scoped role whose grant list contains a TENANT-scoped id. §5.2 step 4 is explicit:
    // "A store-scoped grant can NEVER satisfy a tenant-scoped permission, even if the role's grant
    // list contains it."
    const snap = v0Snapshot({
      roles: { [ROLE_STAFF]: role('store', ['notes.create', 'auth.role_manage']) },
    });
    // Positive control: the same grant DOES satisfy a store-scoped id (T-14b — the grant is live).
    expect(evaluate(snap, staffQuery({ permissionId: 'notes.create' }))).toEqual(ALLOWED);
    // And still denies the tenant-scoped one.
    expect(evaluate(snap, staffQuery({ permissionId: 'auth.role_manage' }))).toEqual(
      denied('not_granted'),
    );
  });

  test('a tenant-wide grant satisfies a store-scoped permission in EVERY store (FR-1037)', () => {
    const snap = v0Snapshot();
    for (const storeId of [STORE_A, STORE_B, 'store-never-seen-before']) {
      expect(
        evaluate(snap, {
          userId: USER_OWNER,
          tenantId: TENANT,
          storeId,
          permissionId: 'notes.create',
        }),
        storeId,
      ).toEqual(ALLOWED);
    }
  });

  test('a store-scoped grant satisfies a store-scoped permission in its OWN store only', () => {
    const snap = v0Snapshot();
    // Control: granted store allows.
    expect(
      evaluate(snap, {
        userId: USER_STORE_OWNER,
        tenantId: TENANT,
        storeId: STORE_A,
        permissionId: 'auth.user_create',
      }),
    ).toEqual(ALLOWED);
    // A different store denies — the grant does not travel.
    expect(
      evaluate(snap, {
        userId: USER_STORE_OWNER,
        tenantId: TENANT,
        storeId: STORE_B,
        permissionId: 'auth.user_create',
      }),
    ).toEqual(denied('not_granted'));
  });

  test('union semantics: two roles each holding half together allow both (FR-1023)', () => {
    const snap = v0Snapshot({
      roles: {
        'role-half-a': role('store', ['notes.create']),
        'role-half-b': role('store', ['notes.archive']),
      },
      grants: {
        [USER_STAFF]: [
          { roleId: 'role-half-a', storeId: STORE_A },
          { roleId: 'role-half-b', storeId: STORE_A },
        ],
      },
    });
    expect(evaluate(snap, staffQuery({ permissionId: 'notes.create' }))).toEqual(ALLOWED);
    expect(evaluate(snap, staffQuery({ permissionId: 'notes.archive' }))).toEqual(ALLOWED);
    // Neither role holds this one — the union adds, it does not invent.
    expect(evaluate(snap, staffQuery({ permissionId: 'notes.edit' }))).toEqual(
      denied('not_granted'),
    );
  });

  test('a store-scoped role granted with a null storeId is dropped as malformed (§5.2 step 5)', () => {
    // Control: the SAME store-scoped role, granted correctly at STORE_A, allows.
    expect(evaluate(v0Snapshot(), staffQuery())).toEqual(ALLOWED);

    // The malformed grant must be dropped — NOT read as a tenant-wide grant. If it were, a
    // malformed row would silently widen a store role into every store of the tenant.
    const snap = v0Snapshot({
      grants: { [USER_STAFF]: [{ roleId: ROLE_STAFF, storeId: null }] },
    });
    expect(evaluate(snap, staffQuery())).toEqual(denied('not_granted'));
    expect(evaluate(snap, staffQuery({ storeId: STORE_B }))).toEqual(denied('not_granted'));
  });

  test("scope: 'tenant' ignores the passed storeId entirely (§5.2 step 3)", () => {
    const snap = v0Snapshot();
    for (const storeId of [STORE_A, STORE_B, null]) {
      expect(
        evaluate(snap, {
          userId: USER_OWNER,
          tenantId: TENANT,
          storeId,
          permissionId: 'auth.role_manage',
        }),
        String(storeId),
      ).toEqual(ALLOWED);
    }
  });

  test('§12 built-in denial fixture: staff attempting auth.user_create', () => {
    expect(evaluate(v0Snapshot(), staffQuery({ permissionId: 'notes.create' }))).toEqual(ALLOWED);
    expect(evaluate(v0Snapshot(), staffQuery({ permissionId: 'auth.user_create' }))).toEqual(
      denied('not_granted'),
    );
  });

  test('§12 built-in denial fixture: a zero-grant user attempting notes.create (04 §8)', () => {
    const snap = v0Snapshot();
    // The user exists and is active — the denial is about grants, nothing else (T-14b).
    expect(snap.users.get(USER_ZERO_GRANTS)?.status).toBe('active');
    expect(
      evaluate(snap, {
        userId: USER_ZERO_GRANTS,
        tenantId: TENANT,
        storeId: STORE_A,
        permissionId: 'notes.create',
      }),
    ).toEqual(denied('not_granted'));
  });
});

describe('the §12 authz matrix', () => {
  const cases = [
    { user: USER_OWNER, ids: MAIN_OWNER_IDS, count: MATRIX_COUNTS.main_owner, label: 'main_owner' },
    {
      user: USER_STORE_OWNER,
      ids: STORE_OWNER_IDS,
      count: MATRIX_COUNTS.store_owner,
      label: 'store_owner',
    },
    { user: USER_STAFF, ids: STAFF_IDS, count: MATRIX_COUNTS.staff, label: 'staff' },
  ];

  for (const { user, ids, count, label } of cases) {
    test(`${label} holds exactly its ${count} matrix permissions and nothing else`, () => {
      // T-14: the fixture's own denominator — a silently-shrunk grant list must fail here, not
      // pass as "no violations found".
      expect(ids).toHaveLength(count);

      const snap = v0Snapshot();
      const held = new Set(ids);
      let allowed = 0;
      for (const entry of registry.all()) {
        const result = evaluate(snap, {
          userId: user,
          tenantId: TENANT,
          storeId: STORE_A,
          permissionId: entry.id,
        });
        if (held.has(entry.id)) {
          expect(result, `${label} should hold ${entry.id}`).toEqual(ALLOWED);
          allowed += 1;
        } else {
          expect(result, `${label} must NOT hold ${entry.id}`).toEqual(denied('not_granted'));
        }
      }
      expect(allowed).toBe(count);
    });
  }
});

describe('computeEffectiveSet (02-permissions §5.2 steps 4–6)', () => {
  test('separates tenant-scope and store-scope sets; a tenant-wide grant lands in both', () => {
    const effective = computeEffectiveSet(v0Snapshot(), USER_OWNER, STORE_A);
    expect(effective.tenantScope.has('auth.role_manage')).toBe(true);
    expect(effective.storeScope.has('auth.role_manage')).toBe(true);
    expect(effective.storeScope.has('notes.create')).toBe(true);
  });

  test('a store grant lands in storeScope only — never in tenantScope', () => {
    const effective = computeEffectiveSet(v0Snapshot(), USER_STORE_OWNER, STORE_A);
    expect(effective.storeScope.has('auth.user_create')).toBe(true);
    expect(effective.tenantScope.size).toBe(0);
  });

  test('a grant for another store contributes to neither set', () => {
    const effective = computeEffectiveSet(v0Snapshot(), USER_STORE_OWNER, STORE_B);
    expect(effective.storeScope.size).toBe(0);
    expect(effective.tenantScope.size).toBe(0);
  });

  test('throws on a corrupt permission_ids row — the caller turns it into evaluation_error', () => {
    const snap = snapshot({
      users: { [USER_STAFF]: { status: 'active' } },
      roles: { [ROLE_STAFF]: { scopeType: 'store', permissionIdsJson: 'not json at all' } },
      grants: { [USER_STAFF]: [{ roleId: ROLE_STAFF, storeId: STORE_A }] },
    });
    expect(() => computeEffectiveSet(snap, USER_STAFF, STORE_A)).toThrow();
  });
});
