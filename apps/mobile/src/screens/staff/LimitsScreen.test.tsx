// "Batas wewenang": the store owner sets a limited role's amounts. Mounts the real screen over fake
// server calls to prove the right role and amounts are sent, that an empty field is never sent as
// Rp 0, that offline never looks like success, and that nobody is offered their own role's limits.
import {
  StaffAdminError,
  type StaffDirectory,
  type StaffMember,
  type StaffRole,
} from '@bolusi/core';
import { t } from '@bolusi/i18n';
import { act } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { fire, render, textsIn } from '../../../../../packages/ui/test/render.js';

import { LimitsScreen, type LimitsScreenProps } from './LimitsScreen.js';

const MANAGER: StaffRole = {
  id: 'r-manager',
  key: 'manager',
  ownerRole: false,
  limits: { priceDrop: 50_000, refund: 0, credit: 100_000 },
};
const ROLES: StaffRole[] = [
  { id: 'r-cashier', key: 'cashier', ownerRole: false, limits: null },
  MANAGER,
  { id: 'r-store', key: 'store_owner', ownerRole: true, limits: null },
];

function person(id: string, roleIds: string[]): StaffMember {
  return {
    id,
    name: id,
    active: true,
    roleKeys: [],
    roleIds,
    owner: roleIds.includes('r-store'),
    hasPin: true,
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

function setup(over: Partial<LimitsScreenProps> = {}, roles: StaffRole[] = ROLES) {
  let directory: StaffDirectory = { roles, members: [person('u-me', ['r-store'])] };
  const props: LimitsScreenProps = {
    actor: { userId: 'u-me', tenantAdmin: false },
    load: vi.fn(() => Promise.resolve(directory)),
    onSave: vi.fn((roleId, limits) => {
      directory = {
        ...directory,
        roles: directory.roles.map((role) => (role.id === roleId ? { ...role, limits } : role)),
      };
      return Promise.resolve();
    }),
    onClose: vi.fn(),
    ...over,
  };
  const screen = render(<LimitsScreen {...props} />);
  return {
    screen,
    props,
    press: (testID: string) => fire(screen.get(testID), 'onPress'),
    type: (testID: string, text: string) => fire(screen.get(testID), 'onChangeText', text),
  };
}

describe('one limited role', () => {
  test('opens its form with the saved amounts and sends what was typed', async () => {
    const { screen, props, press, type } = setup();
    await flush();
    expect(screen.query('limits-form-manager')).not.toBeNull();
    type('limits-refund.field', 'Rp 25.000');
    press('limits-save');
    await flush();
    expect(props.onSave).toHaveBeenCalledWith('r-manager', {
      priceDrop: 50_000,
      refund: 25_000,
      credit: 100_000,
    });
    expect(textsIn(screen.get('limits-notice')).join(' ')).toContain(
      t('auth.limits.saved', { role: t('role.manager.name') }),
    );
  });

  test('an emptied field is not Rp 0: it says so and sends nothing', async () => {
    const { screen, props, press, type } = setup();
    await flush();
    type('limits-credit.field', '');
    press('limits-save');
    await flush();
    expect(props.onSave).not.toHaveBeenCalled();
    expect(textsIn(screen.get('limits-form-manager')).join(' ')).toContain(
      t('auth.limits.missing'),
    );
  });

  test('offline: says so and keeps what was typed', async () => {
    const onSave = vi.fn(() => Promise.reject(new StaffAdminError('offline')));
    const { screen, press, type } = setup({ onSave });
    await flush();
    type('limits-priceDrop.field', '75000');
    press('limits-save');
    await flush();
    expect(textsIn(screen.get('limits-failure')).join(' ')).toContain(
      t('auth.limits.failure.offline'),
    );
    expect(screen.query('limits-notice')).toBeNull();
    press('limits-save');
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  test('leaving with changes asks first', async () => {
    const { screen, props, type } = setup();
    await flush();
    type('limits-refund.field', '1');
    fire(screen.get('staff-screen.back'), 'onPress');
    expect(screen.query('limits-discard')).not.toBeNull();
    expect(props.onClose).not.toHaveBeenCalled();
  });
});

test('several limited roles: a list first, each with its amounts', async () => {
  const second: StaffRole = { ...MANAGER, id: 'r-m2', key: 'technician' };
  const { screen, press } = setup({}, [...ROLES, second]);
  await flush();
  const list = textsIn(screen.get('limits-list')).join(' | ');
  expect(list).toContain(t('role.manager.name'));
  expect(list).toContain(
    // Breaks only between amounts, never inside one.
    'Diskon\u00a0Rp\u00a050.000 · Refund\u00a0Rp\u00a00 · Bayar\u00a0nanti\u00a0Rp\u00a0100.000',
  );
  press('limits-role-manager');
  expect(screen.query('limits-form-manager')).not.toBeNull();
});

test('nobody is offered their own role’s limits', async () => {
  const { screen } = setup({
    actor: { userId: 'u-me', tenantAdmin: false },
    load: () =>
      Promise.resolve({ roles: ROLES, members: [person('u-me', ['r-store', 'r-manager'])] }),
  });
  await flush();
  expect(screen.query('limits-form-manager')).toBeNull();
  expect(textsIn(screen.get('staff-screen')).join(' ')).toContain(t('auth.limits.empty'));
});
