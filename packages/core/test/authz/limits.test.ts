// Limits on owners' money decisions (authz/limits.ts): how far a limited role may use a permission,
// decided once for the device and the server. Every "not allowed" case carries a control that
// allows with the single trigger removed, so a denial is never for the wrong reason.
import { describe, expect, test } from 'vitest';

import {
  allowanceCovers,
  assemblePermissionRegistry,
  evaluateAllowance,
  parseLimitAmounts,
  type DirectoryRole,
  type LimitAmounts,
  type PermissionQuery,
} from '../../src/index.js';
import { snapshot, STORE_A, STORE_B, TENANT } from './_fixtures.js';

const registry = assemblePermissionRegistry([
  {
    id: 'shop',
    permissions: {
      'shop.discount': {
        scope: 'store',
        isDangerous: true,
        description: 'Can lower a price.',
        limit: 'priceDrop',
      },
      'shop.refund': {
        scope: 'store',
        isDangerous: true,
        description: 'Can give money back.',
        limit: 'refund',
      },
      'shop.read': { scope: 'store', isDangerous: false, description: 'Can read.' },
    },
  },
]);

const MANAGER = 'u-manager';
const OWNER = 'u-owner';
const ROLE_MANAGER = 'r-manager';
const ROLE_SENIOR = 'r-senior';
const ROLE_OWNER = 'r-owner';

function limited(
  permissionIds: readonly string[],
  limits: Readonly<Record<string, Partial<LimitAmounts>>>,
): DirectoryRole {
  return {
    scopeType: 'store',
    permissionIdsJson: JSON.stringify(permissionIds),
    limits: new Map(
      Object.entries(limits).map(([store, amounts]) => [store, parseLimitAmounts(amounts)]),
    ),
  };
}

const free = (permissionIds: readonly string[], scopeType: 'tenant' | 'store' = 'store') => ({
  scopeType,
  permissionIdsJson: JSON.stringify(permissionIds),
});

function query(overrides: Partial<PermissionQuery> = {}): PermissionQuery {
  return {
    userId: MANAGER,
    tenantId: TENANT,
    storeId: STORE_A,
    permissionId: 'shop.discount',
    ...overrides,
  };
}

function directory(roles: Record<string, DirectoryRole>, grants: Record<string, string[]>) {
  return snapshot({
    users: { [MANAGER]: { status: 'active' }, [OWNER]: { status: 'active' } },
    roles,
    grants: Object.fromEntries(
      Object.entries(grants).map(([user, roleIds]) => [
        user,
        roleIds.map((roleId) =>
          roleId === ROLE_OWNER ? { roleId, storeId: null } : { roleId, storeId: STORE_A },
        ),
      ]),
    ),
  });
}

describe('evaluateAllowance', () => {
  test('a limited role goes as far as its store set, per kind', () => {
    const snap = directory(
      {
        [ROLE_MANAGER]: limited(['shop.discount', 'shop.refund'], {
          [STORE_A]: { priceDrop: 50_000, refund: 20_000 },
        }),
      },
      { [MANAGER]: [ROLE_MANAGER] },
    );
    expect(evaluateAllowance(registry, snap, query())).toStrictEqual({
      allowed: true,
      limit: 50_000,
    });
    expect(evaluateAllowance(registry, snap, query({ permissionId: 'shop.refund' }))).toStrictEqual(
      { allowed: true, limit: 20_000 },
    );
  });

  test('a store that set nothing gives a limited role Rp 0, never "no limit"', () => {
    const snap = directory(
      { [ROLE_MANAGER]: limited(['shop.discount'], { [STORE_B]: { priceDrop: 90_000 } }) },
      { [MANAGER]: [ROLE_MANAGER] },
    );
    expect(evaluateAllowance(registry, snap, query())).toStrictEqual({ allowed: true, limit: 0 });
  });

  test('a role free of limits, or a permission with no limit kind, has no limit', () => {
    const snap = directory(
      { [ROLE_OWNER]: free(['shop.discount', 'shop.read'], 'tenant') },
      { [OWNER]: [ROLE_OWNER] },
    );
    expect(evaluateAllowance(registry, snap, query({ userId: OWNER }))).toStrictEqual({
      allowed: true,
      limit: null,
    });
    const manager = directory(
      { [ROLE_MANAGER]: limited(['shop.read'], {}) },
      { [MANAGER]: [ROLE_MANAGER] },
    );
    expect(
      evaluateAllowance(registry, manager, query({ permissionId: 'shop.read' })),
    ).toStrictEqual({ allowed: true, limit: null });
  });

  test('two roles: the higher limit, and none once a role holding it is free of limits', () => {
    const roles = {
      [ROLE_MANAGER]: limited(['shop.discount'], { [STORE_A]: { priceDrop: 50_000 } }),
      [ROLE_SENIOR]: limited(['shop.discount'], { [STORE_A]: { priceDrop: 80_000 } }),
    };
    expect(
      evaluateAllowance(
        registry,
        directory(roles, { [MANAGER]: [ROLE_MANAGER, ROLE_SENIOR] }),
        query(),
      ),
    ).toStrictEqual({ allowed: true, limit: 80_000 });
    expect(
      evaluateAllowance(
        registry,
        directory(
          { ...roles, [ROLE_SENIOR]: free(['shop.discount']) },
          { [MANAGER]: [ROLE_MANAGER, ROLE_SENIOR] },
        ),
        query(),
      ),
    ).toStrictEqual({ allowed: true, limit: null });
  });

  test('a role that does not hold the permission adds nothing to the limit', () => {
    const snap = directory(
      {
        [ROLE_MANAGER]: limited(['shop.discount'], { [STORE_A]: { priceDrop: 10_000 } }),
        // Free of limits, but without the discount: must not lift the manager's limit.
        [ROLE_SENIOR]: free(['shop.read']),
      },
      { [MANAGER]: [ROLE_MANAGER, ROLE_SENIOR] },
    );
    expect(evaluateAllowance(registry, snap, query())).toStrictEqual({
      allowed: true,
      limit: 10_000,
    });
  });

  test('not holding it, or an inactive user, is not allowed at all', () => {
    const roles = {
      [ROLE_MANAGER]: limited(['shop.discount'], { [STORE_A]: { priceDrop: 10_000 } }),
    };
    expect(
      evaluateAllowance(registry, directory(roles, { [MANAGER]: [ROLE_MANAGER] }), query()).allowed,
    ).toBe(true);
    expect(evaluateAllowance(registry, directory(roles, { [MANAGER]: [] }), query())).toStrictEqual(
      {
        allowed: false,
      },
    );
    const inactive = snapshot({
      users: { [MANAGER]: { status: 'deactivated' } },
      roles,
      grants: { [MANAGER]: [{ roleId: ROLE_MANAGER, storeId: STORE_A }] },
    });
    expect(evaluateAllowance(registry, inactive, query())).toStrictEqual({ allowed: false });
  });

  test('another store’s limit never applies here', () => {
    const roles = {
      [ROLE_MANAGER]: limited(['shop.discount'], {
        [STORE_A]: { priceDrop: 5_000 },
        [STORE_B]: { priceDrop: 500_000 },
      }),
    };
    expect(
      evaluateAllowance(registry, directory(roles, { [MANAGER]: [ROLE_MANAGER] }), query()),
    ).toStrictEqual({ allowed: true, limit: 5_000 });
  });
});

describe('allowanceCovers', () => {
  test('within, at and over the limit; nothing to cover needs only the permission', () => {
    const allowance = { allowed: true, limit: 50_000 } as const;
    expect(allowanceCovers(allowance, 49_999)).toBe(true);
    expect(allowanceCovers(allowance, 50_000)).toBe(true);
    expect(allowanceCovers(allowance, 50_001)).toBe(false);
    expect(allowanceCovers({ allowed: true, limit: 0 }, 0)).toBe(true);
    expect(allowanceCovers({ allowed: true, limit: 0 }, 1)).toBe(false);
    expect(allowanceCovers({ allowed: true, limit: null }, 10 ** 12)).toBe(true);
    expect(allowanceCovers({ allowed: false }, 0)).toBe(false);
  });
});

describe('parseLimitAmounts', () => {
  test('keeps whole positive amounts of known kinds; anything else is Rp 0', () => {
    expect(
      parseLimitAmounts({ priceDrop: 1_000, refund: -5, credit: 1.5, other: 9 }),
    ).toStrictEqual({
      priceDrop: 1_000,
      refund: 0,
      credit: 0,
    });
    expect(parseLimitAmounts('garbage')).toStrictEqual({ priceDrop: 0, refund: 0, credit: 0 });
  });
});
