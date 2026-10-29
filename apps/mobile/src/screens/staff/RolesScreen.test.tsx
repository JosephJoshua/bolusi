// "Tugas karyawan": the main owner's role editor. Mounts the real screen over fake server calls to
// prove the switches send the right permissions (with what they need), a made role is named,
// renamed and deleted only while nobody holds it, a name is never a preset's, and offline never
// looks like success.
import {
  StaffAdminError,
  type StaffDirectory,
  type StaffMember,
  type StaffRole,
} from '@bolusi/core';
import { t } from '@bolusi/i18n';
import { PRESET_ROLE_ABILITIES, permissionsFor } from '@bolusi/modules/roles';
import { act } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { fire, render, textsIn } from '../../../../../packages/ui/test/render.js';

import { RolesScreen, type RolesScreenProps } from './RolesScreen.js';

const preset = (id: string, key: keyof typeof PRESET_ROLE_ABILITIES): StaffRole => ({
  id,
  key,
  custom: false,
  permissionIds: permissionsFor(new Set(PRESET_ROLE_ABILITIES[key])),
  ownerRole: false,
  limits: key === 'manager' ? { priceDrop: 0, refund: 0, credit: 0 } : null,
});
const SENIOR: StaffRole = {
  ...preset('r-senior', 'cashier'),
  key: 'Kasir senior',
  custom: true,
};
const ROLES: StaffRole[] = [
  preset('r-cashier', 'cashier'),
  preset('r-tech', 'technician'),
  SENIOR,
  {
    id: 'r-store',
    key: 'store_owner',
    custom: false,
    permissionIds: [],
    ownerRole: true,
    limits: null,
  },
];

function person(id: string, roleIds: string[]): StaffMember {
  return { id, name: id, active: true, roleKeys: [], roleIds, owner: false, hasPin: true };
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

function setup(over: Partial<RolesScreenProps> = {}, members: StaffMember[] = []) {
  const directory: StaffDirectory = { roles: ROLES, members };
  const props: RolesScreenProps = {
    load: vi.fn(() => Promise.resolve(directory)),
    onCreate: vi.fn(() => Promise.resolve({ roleId: 'r-senior' })),
    onUpdate: vi.fn(() => Promise.resolve()),
    onDelete: vi.fn(() => Promise.resolve()),
    onClose: vi.fn(),
    ...over,
  };
  const screen = render(<RolesScreen {...props} />);
  return {
    screen,
    props,
    press: (testID: string) => fire(screen.get(testID), 'onPress'),
    type: (testID: string, text: string) => fire(screen.get(testID), 'onChangeText', text),
    on: (abilityId: string) =>
      screen.get(`roles-ability-${abilityId}`).props['accessibilityState']?.checked === true,
  };
}

test('the owners’ roles are listed as fixed and open nothing', async () => {
  const { screen } = setup();
  await flush();
  expect(screen.query('roles-role-r-cashier')).not.toBeNull();
  expect(screen.get('roles-owner-store_owner').props['onPress']).toBeUndefined();
});

describe('a role’s switches', () => {
  test('a switch brings what it needs, and saving sends the permissions behind them', async () => {
    const { screen, props, press, on } = setup();
    await flush();
    press('roles-role-r-tech');
    expect(on('repairPrice')).toBe(false);
    press('roles-ability-repairDiscount');
    expect(on('repairDiscount') && on('repairPrice')).toBe(true);
    press('roles-save');
    await flush();
    const [, change] = vi.mocked(props.onUpdate).mock.calls[0]!;
    expect(change.permissionIds).toEqual(
      expect.arrayContaining(['repair.discount', 'repair.quote_change', 'repair.work']),
    );
    expect(textsIn(screen.get('roles-notice')).join(' ')).toContain(
      t('auth.roles.saved', { role: t('role.technician.name') }),
    );
  });

  test('switching off what others need switches them off too', async () => {
    const { press, on } = setup();
    await flush();
    press('roles-role-r-cashier');
    press('roles-ability-repairView');
    expect(on('repairIntake') || on('repairPrice') || on('repairHandover')).toBe(false);
  });

  test('a limited role is offered only with a decision a limit covers', async () => {
    const { screen, press } = setup();
    await flush();
    press('roles-role-r-tech');
    expect(screen.query('roles-limited')).toBeNull();
    press('roles-ability-moneyView');
    press('roles-ability-moneyRefund');
    // Its first such decision makes it limited (Rp 0 until the owner sets limits), not unlimited.
    expect(screen.get('roles-limited').props['accessibilityState']?.checked).toBe(true);
  });

  test('offline: says so and keeps what was changed', async () => {
    const onUpdate = vi.fn(() => Promise.reject(new StaffAdminError('offline')));
    const { screen, press, on } = setup({ onUpdate });
    await flush();
    press('roles-role-r-tech');
    press('roles-ability-notes');
    press('roles-save');
    await flush();
    expect(textsIn(screen.get('roles-failure')).join(' ')).toContain(
      t('auth.roles.failure.offline'),
    );
    expect(on('notes')).toBe(true);
  });

  test('leaving with changes asks first', async () => {
    const { screen, props, press } = setup();
    await flush();
    press('roles-role-r-tech');
    press('roles-ability-notes');
    fire(screen.get('staff-screen.back'), 'onPress');
    expect(screen.query('roles-discard')).not.toBeNull();
    expect(props.onClose).not.toHaveBeenCalled();
  });
});

describe('a made role', () => {
  test('a new one needs a name no role has, and starts from the chosen role', async () => {
    const { screen, props, press, type } = setup();
    await flush();
    press('roles-add');
    type('roles-add-name.field', 'kasir');
    press('roles-add-save');
    expect(props.onCreate).not.toHaveBeenCalled();
    expect(textsIn(screen.get('staff-screen')).join(' ')).toContain(t('auth.roles.problem.taken'));
    type('roles-add-name.field', '  Kasir pagi ');
    press('roles-add-from-r-tech');
    press('roles-add-save');
    await flush();
    expect(props.onCreate).toHaveBeenCalledWith('Kasir pagi', 'r-tech');
  });

  test('is renamed, and deleted only while nobody holds it', async () => {
    const held = setup({}, [person('u-1', ['r-senior'])]);
    await flush();
    held.press('roles-role-r-senior');
    expect(held.screen.get('roles-delete').props['disabled']).toBe(true);

    const free = setup();
    await flush();
    free.press('roles-role-r-senior');
    free.type('roles-name.field', 'Kasir utama');
    free.press('roles-save');
    await flush();
    expect(free.props.onUpdate).toHaveBeenCalledWith('r-senior', { name: 'Kasir utama' });
    free.press('roles-role-r-senior');
    free.press('roles-delete');
    fire(free.screen.get('roles-delete-confirm.confirm'), 'onPress');
    await flush();
    expect(free.props.onDelete).toHaveBeenCalledWith('r-senior');
  });

  test('a preset has no name field and no delete', async () => {
    const { screen, press } = setup();
    await flush();
    press('roles-role-r-cashier');
    expect(screen.query('roles-name')).toBeNull();
    expect(screen.query('roles-delete')).toBeNull();
  });
});
