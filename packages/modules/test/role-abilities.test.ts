// The role editor's switches against the real permission registry: every store permission has a
// place, and what the switches make is what the server takes.
import { describe, expect, test } from 'vitest';

import { assemblePermissionRegistry } from '@bolusi/core';

import { ALL_MODULES } from '../src/index.js';
import {
  abilitiesOf,
  LIMITED_ABILITIES,
  normalizeRolePermissions,
  OWNER_ONLY_PERMISSIONS,
  permissionsFor,
  ROLE_ABILITIES,
  ROLE_BASE_PERMISSIONS,
  toggleAbility,
  RISKY_ABILITIES,
  riskyAbilities,
} from '../src/role-abilities.js';

const registry = assemblePermissionRegistry(
  ALL_MODULES.map((m) => ({
    id: m.id,
    ...(m.permissions === undefined ? {} : { permissions: m.permissions }),
    ...(m.commands === undefined ? {} : { commands: m.commands }),
    ...(m.queries === undefined ? {} : { queries: m.queries }),
  })),
);

describe('every store permission has one place', () => {
  const offered = ROLE_ABILITIES.flatMap((ability) => ability.permissionIds);
  const placed = [...offered, ...ROLE_BASE_PERMISSIONS, ...OWNER_ONLY_PERMISSIONS];

  test('each is behind a switch, held by every role, or kept for the owners', () => {
    const store = registry
      .all()
      .filter((p) => p.scope === 'store')
      .map((p) => p.id);
    expect(store.filter((id) => !placed.includes(id))).toStrictEqual([]);
  });

  test('only once, and never a business-wide one', () => {
    expect(new Set(placed).size).toBe(placed.length);
    expect(
      placed.filter((id) => registry.all().find((p) => p.id === id)?.scope !== 'store'),
    ).toStrictEqual([]);
  });
});

test('the switches a limit covers are exactly those with a limited permission behind them', () => {
  const limited = ROLE_ABILITIES.filter((ability) =>
    ability.permissionIds.some((id) => registry.get(id)?.limit !== undefined),
  ).map((ability) => ability.id);
  expect([...limited].sort()).toStrictEqual([...LIMITED_ABILITIES].sort());
});

test('switching one on brings what it needs; off takes down what needs it', () => {
  const discount = toggleAbility(new Set(), 'repairDiscount', true);
  expect([...discount].sort()).toStrictEqual(['repairDiscount', 'repairPrice', 'repairView']);
  const noView = toggleAbility(discount, 'repairView', false);
  expect([...noView]).toStrictEqual([]);
});

describe('what the server takes', () => {
  test('a list the switches make, base included', () => {
    const list = permissionsFor(new Set(['repairView', 'repairWork']));
    expect(normalizeRolePermissions(list)).toStrictEqual(list);
    expect(list).toEqual(expect.arrayContaining([...ROLE_BASE_PERMISSIONS]));
  });

  test('the base ones are added when missing', () => {
    expect(normalizeRolePermissions(['repair.read'])).toStrictEqual(
      permissionsFor(new Set(['repairView'])),
    );
  });

  test('an owner-only permission, half a switch, or a switch without its needs is refused', () => {
    expect(normalizeRolePermissions(['auth.user_create'])).toBeNull();
    expect(normalizeRolePermissions(['money.read', 'money.move_cash'])).toBeNull();
    expect(normalizeRolePermissions(['repair.work'])).toBeNull();
    expect(normalizeRolePermissions(['made.up'])).toBeNull();
  });

  test('a switch is on only when all of it is held', () => {
    expect(abilitiesOf(['money.read', 'money.move_cash']).has('moneyCash')).toBe(false);
  });
});

test('the editor marks exactly the switches behind which a module declares a dangerous permission', () => {
  const derived = riskyAbilities(ALL_MODULES as unknown as Parameters<typeof riskyAbilities>[0]);
  expect([...RISKY_ABILITIES].sort()).toEqual([...derived].sort());
  // Discounts and cancels are risky; seeing the servisan list is not.
  expect(RISKY_ABILITIES.has('repairDiscount')).toBe(true);
  expect(RISKY_ABILITIES.has('repairView')).toBe(false);
});
