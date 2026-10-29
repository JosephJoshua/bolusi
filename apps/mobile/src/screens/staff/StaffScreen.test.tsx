// "Karyawan": the owner's staff list, add, edit, deactivate and reactivate. Mounts the real screen over
// fake server calls to prove each step calls the right change for the right person, that a refusal
// (offline above all) never looks like success, and that a store owner is never offered owner powers.
import {
  StaffAdminError,
  type StaffDirectory,
  type StaffMember,
  type StaffRole,
} from '@bolusi/core';
import { t } from '@bolusi/i18n';
import { act } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { fire, isUnwired, render, textsIn } from '../../../../../packages/ui/test/render.js';

import { StaffScreen, type StaffScreenProps } from './StaffScreen.js';

const ROLES: StaffRole[] = [
  {
    id: 'r-cashier',
    key: 'cashier',
    custom: false,
    permissionIds: [],
    ownerRole: false,
    limits: null,
  },
  {
    id: 'r-tech',
    key: 'technician',
    custom: false,
    permissionIds: [],
    ownerRole: false,
    limits: null,
  },
  {
    id: 'r-store',
    key: 'store_owner',
    custom: false,
    permissionIds: [],
    ownerRole: true,
    limits: null,
  },
];

function person(id: string, name: string, over: Partial<StaffMember> = {}): StaffMember {
  return {
    id,
    name,
    active: true,
    roleKeys: ['cashier'],
    roleIds: ['r-cashier'],
    owner: false,
    hasPin: true,
    ...over,
  };
}

const ME = person('u-me', 'Paulus', {
  roleKeys: ['store_owner'],
  roleIds: ['r-store'],
  owner: true,
});
const BUDI = person('u-budi', 'Budi');
const NOPIN = person('u-nopin', 'Dewi', { hasPin: false });
const PEER = person('u-peer', 'Marta', {
  roleKeys: ['store_owner'],
  roleIds: ['r-store'],
  owner: true,
});
const GONE = person('u-gone', 'Ana', { active: false, hasPin: false });

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

function setup(over: Partial<StaffScreenProps> = {}, members = [ME, BUDI, NOPIN, PEER, GONE]) {
  let directory: StaffDirectory = { roles: ROLES, members };
  const props: StaffScreenProps = {
    actor: { userId: ME.id, tenantAdmin: false },
    load: vi.fn(() => Promise.resolve(directory)),
    onCreate: vi.fn((draft) => {
      directory = {
        ...directory,
        members: [...directory.members, person('u-new', draft.name, { hasPin: false })],
      };
      return Promise.resolve({ userId: 'u-new' });
    }),
    onUpdate: vi.fn(() => Promise.resolve()),
    onSetActive: vi.fn(() => Promise.resolve()),
    onMakePin: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  const screen = render(<StaffScreen {...props} />);
  return {
    screen,
    props,
    press: (testID: string) => fire(screen.get(testID), 'onPress'),
    type: (testID: string, text: string) => fire(screen.get(testID), 'onChangeText', text),
  };
}

describe('the list', () => {
  test('active people, then the deactivated under their heading, each with what needs the owner', async () => {
    const { screen } = setup();
    await flush();
    const list = textsIn(screen.get('staff-list')).join(' | ');
    expect(list.indexOf(BUDI.name)).toBeLessThan(list.indexOf(t('auth.staff.inactiveSection')));
    expect(list.indexOf(t('auth.staff.inactiveSection'))).toBeLessThan(list.indexOf(GONE.name));
    expect(screen.query(`staff-you-${ME.id}`)).not.toBeNull();
    expect(screen.query(`staff-nopin-${NOPIN.id}`)).not.toBeNull();
    expect(screen.query(`staff-nopin-${BUDI.id}`)).toBeNull();
    expect(screen.query(`staff-inactive-${GONE.id}`)).not.toBeNull();
  });

  test('a store owner cannot open themselves or another owner', async () => {
    const { screen } = setup();
    await flush();
    expect(isUnwired(screen.get(`staff-member-${ME.id}`))).toBe(true);
    expect(isUnwired(screen.get(`staff-member-${PEER.id}`))).toBe(true);
    expect(isUnwired(screen.get(`staff-member-${BUDI.id}`))).toBe(false);
  });

  test('a main owner can open another owner, still not themselves', async () => {
    const { screen } = setup({ actor: { userId: ME.id, tenantAdmin: true } });
    await flush();
    expect(isUnwired(screen.get(`staff-member-${PEER.id}`))).toBe(false);
    expect(isUnwired(screen.get(`staff-member-${ME.id}`))).toBe(true);
  });

  test('only the owner here: the empty state, with the add action', async () => {
    const { screen } = setup({}, [ME]);
    await flush();
    expect(textsIn(screen.get('staff-screen')).join(' ')).toContain(t('auth.staff.empty'));
    expect(screen.query('staff-add')).not.toBeNull();
  });
});

describe('adding someone', () => {
  test('says what is missing and sends nothing', async () => {
    const { screen, props, press } = setup();
    await flush();
    press('staff-add');
    press('staff-add-form-save');
    expect(props.onCreate).not.toHaveBeenCalled();
    expect(textsIn(screen.get('staff-add-form')).join(' ')).toContain(
      t('auth.staff.problem.nameMissing'),
    );
  });

  test('refuses a name someone here already has', async () => {
    const { screen, props, press, type } = setup();
    await flush();
    press('staff-add');
    type('staff-add-form-name.field', 'budi ');
    press('staff-add-form-role-cashier');
    press('staff-add-form-save');
    expect(props.onCreate).not.toHaveBeenCalled();
    expect(textsIn(screen.get('staff-add-form')).join(' ')).toContain(
      t('auth.staff.problem.nameTaken'),
    );
  });

  test('a store owner is offered cashier and technician only', async () => {
    const { screen, press } = setup();
    await flush();
    press('staff-add');
    expect(screen.query('staff-add-form-role-cashier')).not.toBeNull();
    expect(screen.query('staff-add-form-role-technician')).not.toBeNull();
    expect(screen.query('staff-add-form-role-store_owner')).toBeNull();
  });

  test('adds a cashier-technician, then offers their PIN now', async () => {
    const { screen, props, press, type } = setup();
    await flush();
    press('staff-add');
    type('staff-add-form-name.field', '  Rina Wenda ');
    press('staff-add-form-role-cashier');
    press('staff-add-form-role-technician');
    press('staff-add-form-save');
    await flush();

    expect(props.onCreate).toHaveBeenCalledExactlyOnceWith({
      name: 'Rina Wenda',
      roleIds: ['r-cashier', 'r-tech'],
    });
    expect(textsIn(screen.get('staff-added')).join(' ')).toContain(
      t('auth.staff.addedTitle', { name: 'Rina Wenda' }),
    );
    press('staff-added-pin');
    expect(props.onMakePin).toHaveBeenCalledExactlyOnceWith('u-new');
  });

  test('not on this phone yet: says it will come with the next sync, and no PIN offer', async () => {
    const { screen, press, type } = setup({
      // The server took it, but the directory refresh has not brought them here.
      onCreate: vi.fn(() => Promise.resolve({ userId: 'u-elsewhere' })),
    });
    await flush();
    press('staff-add');
    type('staff-add-form-name.field', 'Rina');
    press('staff-add-form-role-cashier');
    press('staff-add-form-save');
    await flush();
    expect(screen.query('staff-added-pin')).toBeNull();
    expect(textsIn(screen.get('staff-added')).join(' ')).toContain(
      t('auth.staff.notYetHere', { name: 'Rina' }),
    );
  });

  test('offline: says so, keeps the form as typed, and a retry sends it', async () => {
    const onCreate = vi
      .fn()
      .mockRejectedValueOnce(new StaffAdminError('offline'))
      .mockResolvedValueOnce({ userId: 'u-x' });
    const { screen, press, type } = setup({ onCreate });
    await flush();
    press('staff-add');
    type('staff-add-form-name.field', 'Rina');
    press('staff-add-form-role-cashier');
    press('staff-add-form-save');
    await flush();

    expect(textsIn(screen.get('staff-add-form-failure')).join(' ')).toContain(
      t('auth.staff.failure.offline'),
    );
    expect(screen.query('staff-added')).toBeNull();
    expect(screen.get('staff-add-form-name.field').props['value']).toBe('Rina');

    press('staff-add-form-save');
    await flush();
    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(screen.query('staff-added')).not.toBeNull();
  });

  test('leaving with something typed asks before throwing it away', async () => {
    const { screen, props, press, type } = setup();
    await flush();
    press('staff-add');
    type('staff-add-form-name.field', 'Rina');
    press('staff-screen.back');
    expect(screen.query('staff-add-form-discard')).not.toBeNull();
    press('staff-add-form-discard.confirm');
    expect(screen.query('staff-list')).not.toBeNull();
    expect(props.onClose).not.toHaveBeenCalled();
  });
});

describe('an active person', () => {
  test('changing only the role sends only the role, then says it saved', async () => {
    const { screen, props, press } = setup();
    await flush();
    press(`staff-member-${BUDI.id}`);
    press('staff-edit-form-role-cashier');
    press('staff-edit-form-role-technician');
    press('staff-edit-form-save');
    await flush();

    expect(props.onUpdate).toHaveBeenCalledExactlyOnceWith(BUDI.id, { roleIds: ['r-tech'] });
    expect(textsIn(screen.get('staff-notice')).join(' ')).toContain(t('auth.staff.saved'));
  });

  test('saving with nothing changed just goes back', async () => {
    const { screen, props, press } = setup();
    await flush();
    press(`staff-member-${BUDI.id}`);
    press('staff-edit-form-save');
    expect(props.onUpdate).not.toHaveBeenCalled();
    expect(screen.query('staff-list')).not.toBeNull();
  });

  test('deactivating asks first, then deactivates THAT person', async () => {
    const { screen, props, press } = setup();
    await flush();
    press(`staff-member-${BUDI.id}`);
    press('staff-deactivate');
    expect(props.onSetActive).not.toHaveBeenCalled();
    press('staff-deactivate-confirm.confirm');
    await flush();
    expect(props.onSetActive).toHaveBeenCalledExactlyOnceWith(BUDI.id, false);
    expect(textsIn(screen.get('staff-notice')).join(' ')).toContain(
      t('auth.staff.deactivated', { name: BUDI.name }),
    );
  });

  test('the server refusing a change shows why and stays on the page', async () => {
    const { screen, press } = setup({
      onSetActive: vi.fn(() => Promise.reject(new StaffAdminError('denied'))),
    });
    await flush();
    press(`staff-member-${BUDI.id}`);
    press('staff-deactivate');
    press('staff-deactivate-confirm.confirm');
    await flush();
    expect(textsIn(screen.get('staff-edit-form-failure')).join(' ')).toContain(
      t('auth.staff.failure.denied'),
    );
    expect(screen.query('staff-edit-form')).not.toBeNull();
  });

  test('someone with no PIN can get one from their page', async () => {
    const { props, press } = setup();
    await flush();
    press(`staff-member-${NOPIN.id}`);
    press('staff-edit-make-pin');
    expect(props.onMakePin).toHaveBeenCalledExactlyOnceWith(NOPIN.id);
  });
});

test('a deactivated person can be reactivated', async () => {
  const { screen, props, press } = setup();
  await flush();
  press(`staff-member-${GONE.id}`);
  expect(screen.query('staff-inactive-page')).not.toBeNull();
  press('staff-reactivate');
  await flush();
  expect(props.onSetActive).toHaveBeenCalledExactlyOnceWith(GONE.id, true);
  expect(screen.query('staff-list')).not.toBeNull();
});
