// The PC's Settings over the offline core: which pages each person gets, and that every change goes
// to the core as the person signed in (their own PIN, a colleague's PIN, "Karyawan") or through the
// repair commands (intake lists, cancellation fees, slips), asking before unsaved changes are lost.
import {
  DomainError,
  PIN_HARD_LOCK_THRESHOLD,
  StaffAdminError,
  type StaffDirectory,
} from '@bolusi/core';
import type { PinTargetUser } from '@bolusi/device/models/pin/pin-target';
import { initI18n } from '@bolusi/i18n';
import { REPAIR_PERMISSION } from '@bolusi/modules/repair';
import { registerRepairCatalog } from '@bolusi/modules/repair/desktop';
import enRepairCatalog from '@bolusi/modules/repair/i18n/en.json';
import idRepairCatalog from '@bolusi/modules/repair/i18n/id.json';
import { TooltipProvider } from '@bolusi/ui-web';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CoreView } from '../src/renderer/use-core.js';

import { ALL, FakeCore, OWNER, ready, session, signedIn, TECH } from './fake-core.js';

let core: FakeCore;

vi.mock('../src/renderer/use-core.js', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useCore: (): CoreView => {
      const state = useSyncExternalStore(
        (listener) => core.subscribe(listener),
        () => core.state,
      );
      return { mode: 'live', client: core.client, state };
    },
  };
});

const { App } = await import('../src/renderer/App.js');

const CASHIER_GRANTS = [
  REPAIR_PERMISSION.read,
  REPAIR_PERMISSION.intake,
  REPAIR_PERMISSION.handover,
];

const DIRECTORY: StaffDirectory = {
  roles: [
    { id: 'r-cashier', key: 'cashier', ownerRole: false, limits: null },
    { id: 'r-tech', key: 'technician', ownerRole: false, limits: null },
    { id: 'r-owner', key: 'store_owner', ownerRole: true, limits: null },
  ],
  members: [
    {
      id: OWNER.id,
      name: OWNER.name,
      active: true,
      roleKeys: ['main_owner'],
      roleIds: ['r-main'],
      owner: true,
      hasPin: true,
    },
    {
      id: TECH.id,
      name: TECH.name,
      active: true,
      roleKeys: ['technician'],
      roleIds: ['r-tech'],
      owner: false,
      hasPin: true,
    },
  ],
};

const TARGETS: readonly PinTargetUser[] = [
  { id: OWNER.id, name: OWNER.name, roleKeys: ['main_owner'], lockedOut: false },
  { id: TECH.id, name: TECH.name, roleKeys: ['technician'], lockedOut: true },
];

function renderApp(): void {
  render(
    <TooltipProvider>
      <App />
    </TooltipProvider>,
  );
}

const byTestId = (id: string): HTMLElement => screen.getByTestId(id);

function typePin(pin: string): void {
  for (const key of pin) fireEvent.keyDown(window, { key });
}

async function openSettings(page?: string): Promise<void> {
  await screen.findByTestId('desktop.shell');
  fireEvent.click(byTestId('nav.settings'));
  await screen.findByTestId('desktop.settings.nav');
  if (page !== undefined) fireEvent.click(byTestId(`desktop.settings.nav.${page}`));
}

function callsTo(method: string): unknown[][] {
  return core.calls.filter((call) => call.method === method).map((call) => call.args);
}

beforeEach(() => {
  window.localStorage.clear();
  initI18n({ locale: 'id' });
  registerRepairCatalog({ id: idRepairCatalog, en: enRepairCatalog });
});
afterEach(cleanup);

describe('Settings on the PC', () => {
  it("gives an owner the store's people and repair settings, a cashier only their own", async () => {
    core = new FakeCore(ready({ session: session(signedIn(OWNER, ALL)) }));
    renderApp();
    await openSettings();
    const nav = byTestId('desktop.settings.nav');
    for (const page of [
      'account',
      'staff',
      'staffPins',
      'limits',
      'fees',
      'uncollected',
      'slip',
      'options.checks',
      'options.readyBy',
      'computer',
    ]) {
      expect(within(nav).getByTestId(`desktop.settings.nav.${page}`)).toBeTruthy();
    }
    cleanup();

    core = new FakeCore(
      ready({
        session: session({
          ...signedIn(TECH, CASHIER_GRANTS),
          canUnlock: false,
          canReset: false,
          canManageStaff: false,
          canSetLimits: false,
          canRenameDevice: false,
          tenantAdmin: false,
        }),
      }),
    );
    renderApp();
    await openSettings();
    const items = within(byTestId('desktop.settings.nav'))
      .getAllByRole('button')
      .map((button) => button.getAttribute('data-testid'));
    expect(items).toEqual(['desktop.settings.nav.account', 'desktop.settings.nav.computer']);
  });

  it('counts the locked colleagues beside "PIN karyawan"', async () => {
    core = new FakeCore(
      ready({
        session: session({
          ...signedIn(OWNER, ALL),
          pinRows: {
            [TECH.id]: {
              userId: TECH.id,
              deviceId: 'd-1',
              consecutiveFailures: PIN_HARD_LOCK_THRESHOLD,
              windowStartedAt: 1,
              notBefore: null,
            },
          },
        }),
      }),
    );
    renderApp();
    await openSettings();
    expect(byTestId('desktop.settings.nav.staffPins').textContent).toContain('1 terkunci');
  });

  it('changes the PIN as the person signed in, and says a wrong current PIN', async () => {
    core = new FakeCore(ready({ session: session(signedIn(TECH, CASHIER_GRANTS)) }));
    let attempt = 0;
    core.answers['session.changePin'] = () => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new DomainError('NOT_AUTHENTICATED'));
      return Promise.resolve();
    };
    renderApp();
    await openSettings();
    fireEvent.click(byTestId('desktop.settings.changePin'));
    await screen.findByTestId('desktop.changePin');
    typePin('111111');
    typePin('222222');
    typePin('222222');
    await waitFor(() =>
      expect(byTestId('desktop.changePin.message').textContent).toBe('PIN lama salah. Coba lagi.'),
    );
    typePin('123456');
    typePin('654321');
    typePin('654321');
    await screen.findByTestId('desktop.changePin.done');
    expect(callsTo('session.changePin')).toEqual([
      [TECH.id, '111111', '222222'],
      [TECH.id, '123456', '654321'],
    ]);
  });

  it('never saves a new PIN whose repeat did not match', async () => {
    core = new FakeCore(ready({ session: session(signedIn(TECH, CASHIER_GRANTS)) }));
    renderApp();
    await openSettings();
    fireEvent.click(byTestId('desktop.settings.changePin'));
    await screen.findByTestId('desktop.changePin');
    typePin('111111');
    typePin('222222');
    typePin('333333');
    await waitFor(() =>
      expect(byTestId('desktop.changePin.message').textContent).toContain('tidak sama'),
    );
    expect(callsTo('session.changePin')).toEqual([]);
  });

  it("unlocks a colleague's PIN after asking, then has them type a new one", async () => {
    core = new FakeCore(ready({ session: session(signedIn(OWNER, ALL)) }));
    core.answers['session.listPinTargets'] = () => TARGETS;
    renderApp();
    await openSettings('staffPins');
    // The owner is not on their own list: their PIN is under "Akun".
    await screen.findByTestId(`desktop.settings.staffPins.row.${TECH.id}`);
    expect(screen.queryByTestId(`desktop.settings.staffPins.row.${OWNER.id}`)).toBeNull();

    fireEvent.click(byTestId(`desktop.settings.staffPins.unlock.${TECH.id}`));
    fireEvent.click(await screen.findByTestId('desktop.settings.staffPins.unlockConfirm.confirm'));
    await screen.findByText('Budi Santoso sudah bisa masuk lagi.');
    expect(callsTo('session.clearLockout')).toEqual([[OWNER.id, TECH.id]]);

    fireEvent.click(byTestId(`desktop.settings.staffPins.reset.${TECH.id}`));
    fireEvent.click(await screen.findByTestId('desktop.resetPin.proceed'));
    typePin('482915');
    typePin('482915');
    await screen.findByTestId('desktop.resetPin.done');
    expect(callsTo('session.resetPin')).toEqual([[OWNER.id, TECH.id, '482915']]);
  });

  it('adds a person, offers their first PIN, and says when the PC is offline', async () => {
    core = new FakeCore(ready({ session: session(signedIn(OWNER, ALL)) }));
    let directory = DIRECTORY;
    core.answers['staff.list'] = () => directory;
    let online = false;
    core.answers['staff.create'] = (_userId, draft) => {
      if (!online) return Promise.reject(new StaffAdminError('offline'));
      const { name, roleIds } = draft as { name: string; roleIds: string[] };
      directory = {
        ...directory,
        members: [
          ...directory.members,
          {
            id: 'u-new',
            name,
            active: true,
            roleKeys: ['cashier'],
            roleIds,
            owner: false,
            hasPin: false,
          },
        ],
      };
      return { userId: 'u-new' };
    };
    renderApp();
    await openSettings('staff');
    fireEvent.click(await screen.findByTestId('desktop.settings.staff.add'));
    const dialog = await screen.findByTestId('desktop.staff.add');

    // Nothing is sent before the form is right.
    fireEvent.click(byTestId('desktop.staff.add.save'));
    expect(dialog.textContent).toContain('Tulis namanya dulu.');
    fireEvent.change(byTestId('desktop.staff.add.name'), { target: { value: 'Maria Kambu' } });
    fireEvent.click(byTestId('desktop.staff.add.save'));
    expect(dialog.textContent).toContain('Pilih tugasnya dulu.');
    expect(callsTo('staff.create')).toEqual([]);

    fireEvent.click(within(byTestId('desktop.staff.add.role.cashier')).getByRole('checkbox'));
    fireEvent.click(byTestId('desktop.staff.add.save'));
    await screen.findByText(/belum terhubung internet/);

    online = true;
    fireEvent.click(byTestId('desktop.staff.add.save'));
    await screen.findByTestId('desktop.staff.added');
    expect(callsTo('staff.create').at(-1)).toEqual([
      OWNER.id,
      { name: 'Maria Kambu', roleIds: ['r-cashier'] },
    ]);
    fireEvent.click(byTestId('desktop.staff.added.makePin'));
    expect((await screen.findByTestId('desktop.resetPin')).textContent).toContain('Maria Kambu');
  });

  it('sets a manager’s limits as the owner signed in, and says when the PC is offline', async () => {
    core = new FakeCore(ready({ session: session(signedIn(OWNER, ALL)) }));
    let directory: StaffDirectory = {
      ...DIRECTORY,
      roles: [
        ...DIRECTORY.roles,
        {
          id: 'r-manager',
          key: 'manager',
          ownerRole: false,
          limits: { priceDrop: 50_000, refund: 0, credit: 100_000 },
        },
      ],
    };
    core.answers['staff.list'] = () => directory;
    let online = false;
    core.answers['staff.setLimits'] = (_userId, roleId, limits) => {
      if (!online) return Promise.reject(new StaffAdminError('offline'));
      directory = {
        ...directory,
        roles: directory.roles.map((role) =>
          role.id === roleId ? { ...role, limits: limits as typeof role.limits } : role,
        ),
      };
      return undefined;
    };
    renderApp();
    await openSettings('limits');
    const refund = await screen.findByTestId('desktop.settings.limits.manager.refund');
    fireEvent.change(refund, { target: { value: '25.000' } });

    // An emptied amount is not Rp 0: nothing is sent.
    const credit = byTestId('desktop.settings.limits.manager.credit');
    fireEvent.change(credit, { target: { value: '' } });
    fireEvent.click(byTestId('desktop.settings.limits.save'));
    expect(byTestId('desktop.settings.limits').textContent).toContain('Isi ketiga batas');
    expect(callsTo('staff.setLimits')).toEqual([]);

    fireEvent.change(credit, { target: { value: '100.000' } });
    fireEvent.click(byTestId('desktop.settings.limits.save'));
    await screen.findByText(/belum terhubung internet/);

    online = true;
    fireEvent.click(byTestId('desktop.settings.limits.save'));
    await screen.findByTestId('desktop.settings.limits.saved');
    expect(callsTo('staff.setLimits').at(-1)).toEqual([
      OWNER.id,
      'r-manager',
      { priceDrop: 50_000, refund: 25_000, credit: 100_000 },
    ]);
  });

  it('renames this PC as the owner signed in, and keeps the dialog open while offline', async () => {
    core = new FakeCore(ready({ session: session(signedIn(OWNER, ALL)) }));
    let online = false;
    core.answers['device.rename'] = (_userId, name) => {
      if (!online) return Promise.reject(new StaffAdminError('offline'));
      core.set({ deviceInfo: { ...core.state.deviceInfo!, deviceName: name as string } });
      return undefined;
    };
    renderApp();
    await openSettings('computer');
    fireEvent.click(byTestId('desktop.device.rename'));
    const field = (await screen.findByTestId('desktop.rename.name')) as HTMLInputElement;
    expect(field.value).toBe('PC Kasir');

    // A blank name is not sent.
    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.click(byTestId('desktop.rename.save'));
    expect(byTestId('desktop.rename').textContent).toContain('Isi namanya dulu');
    expect(callsTo('device.rename')).toEqual([]);

    fireEvent.change(field, { target: { value: ' Kasir depan ' } });
    fireEvent.click(byTestId('desktop.rename.save'));
    await screen.findByText(/belum terhubung internet/);
    expect(byTestId('desktop.device.name').textContent).toBe('PC Kasir');

    online = true;
    fireEvent.click(byTestId('desktop.rename.save'));
    await waitFor(() => expect(screen.queryByTestId('desktop.rename')).toBeNull());
    expect(callsTo('device.rename').at(-1)).toEqual([OWNER.id, 'Kasir depan']);
    expect(byTestId('desktop.device.name').textContent).toBe('Kasir depan');
  });

  it('offers no rename to someone who may not register devices', async () => {
    core = new FakeCore(
      ready({ session: session({ ...signedIn(TECH, ALL), canRenameDevice: false }) }),
    );
    renderApp();
    await openSettings('computer');
    expect(byTestId('desktop.device.name').textContent).toBe('PC Kasir');
    expect(screen.queryByTestId('desktop.device.rename')).toBeNull();
  });

  it('does not let a store owner open another owner', async () => {
    core = new FakeCore(
      ready({
        session: session({ ...signedIn(TECH, ALL), tenantAdmin: false }),
      }),
    );
    core.answers['staff.list'] = () => DIRECTORY;
    renderApp();
    await openSettings('staff');
    await screen.findByTestId(`desktop.settings.staff.row.${OWNER.id}`);
    expect(screen.queryByTestId(`desktop.settings.staff.open.${OWNER.id}`)).toBeNull();
  });
});

describe('repair settings on the PC', () => {
  it('saves the cancellation fees through the command', async () => {
    core = new FakeCore(ready({ session: session(signedIn(OWNER, ALL)) }));
    renderApp();
    await openSettings('fees');
    const before = (await screen.findByTestId('repair.desk.fees.beforeWork')) as HTMLInputElement;
    expect((byTestId('repair.desk.fees.save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(before, { target: { value: '35.000' } });
    fireEvent.click(byTestId('repair.desk.fees.save'));
    await screen.findByTestId('repair.desk.fees.saved');
    const run = callsTo('repair.run').find((args) => args[1] === 'setCancelFees');
    expect(run?.[0]).toBe(OWNER.id);
    expect((run?.[2] as { beforeWork: number }).beforeWork).toBe(35_000);
  });

  it('saves after how many days an uncollected phone is flagged, within the allowed range', async () => {
    core = new FakeCore(ready({ session: session(signedIn(OWNER, ALL)) }));
    renderApp();
    await openSettings('uncollected');
    const days = (await screen.findByTestId('repair.desk.uncollected.days')) as HTMLInputElement;
    expect(days.value).toBe('60');
    fireEvent.change(days, { target: { value: '400' } });
    fireEvent.click(byTestId('repair.desk.uncollected.save'));
    expect(screen.getByTestId('repair.desk.uncollected').textContent).toContain('1 sampai 365');
    expect(callsTo('repair.run').some((args) => args[1] === 'setUncollectedDays')).toBe(false);

    fireEvent.change(days, { target: { value: '30' } });
    fireEvent.click(byTestId('repair.desk.uncollected.save'));
    await screen.findByTestId('repair.desk.uncollected.saved');
    const run = callsTo('repair.run').find((args) => args[1] === 'setUncollectedDays');
    expect(run?.[2]).toEqual({ days: 30 });
  });

  it('renames, hides and adds intake items, then saves the list once', async () => {
    core = new FakeCore(ready({ session: session(signedIn(OWNER, ALL)) }));
    renderApp();
    await openSettings('options.accessories');
    const rows = await screen.findByTestId('repair.desk.options.accessories.rows');
    const names = within(rows).getAllByRole('textbox') as HTMLInputElement[];
    fireEvent.change(names[0]!, { target: { value: 'Casing HP' } });
    fireEvent.click(within(rows).getAllByRole('switch')[1]!);
    fireEvent.click(byTestId('repair.desk.options.accessories.add'));
    const added = within(rows).getAllByRole('textbox').at(-1) as HTMLInputElement;
    expect(document.activeElement).toBe(added);

    // An empty new row is pointed out, not saved.
    fireEvent.click(byTestId('repair.desk.options.accessories.save'));
    await screen.findByText('Isi namanya dulu.');
    expect(callsTo('repair.run')).toEqual([]);

    fireEvent.change(added, { target: { value: 'Tali gantungan' } });
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await screen.findByTestId('repair.desk.options.accessories.saved');
    const commands = callsTo('repair.run').map((args) => args[1]);
    expect(commands).toEqual(['changeIntakeOptions', 'hideIntakeOptions']);
    const change = callsTo('repair.run')[0]![2] as { items: { label: string | null }[] };
    expect(change.items[0]!.label).toBe('Casing HP');
    expect(change.items.at(-1)!.label).toBe('Tali gantungan');
  });

  it('sets each repair type’s warranty and whether it needs the ownership video', async () => {
    core = new FakeCore(ready({ session: session(signedIn(OWNER, ALL)) }));
    renderApp();
    await openSettings('options.repairTypes');
    const rows = await screen.findByTestId('repair.desk.options.repairTypes.rows');
    const [first] = within(rows).getAllByTestId(/\.warranty$/) as HTMLInputElement[];
    expect(first!.value).toBe('30');
    // Days only: anything else typed is dropped as it is typed.
    fireEvent.change(first!, { target: { value: '9x0' } });
    expect(first!.value).toBe('90');
    const [video] = within(rows).getAllByTestId(/\.needsVideo$/);
    fireEvent.click(video!);
    fireEvent.click(byTestId('repair.desk.options.repairTypes.save'));
    await screen.findByTestId('repair.desk.options.repairTypes.saved');
    const change = callsTo('repair.run').find((args) => args[1] === 'changeIntakeOptions')![2] as {
      items: { warrantyDays: number; needsVideo: boolean }[];
    };
    expect(change.items[0]).toMatchObject({ warrantyDays: 90, needsVideo: true });
  });

  it("follows another device's slip change, keeping what was typed here", async () => {
    core = new FakeCore(ready({ session: session(signedIn(OWNER, ALL)) }));
    renderApp();
    await openSettings('slip');
    fireEvent.change(await screen.findByTestId('repair.desk.slip.phone'), {
      target: { value: '0811 4800 123' },
    });
    const before = (await core.demo.query('printSettings', {})).rows[0]!;
    await core.demo.run('setPrintSettings', {
      name: before.name ?? '',
      address: 'Jl. Ahmad Yani 12, Sorong',
      phone: before.phone,
      logoOnDotMatrix: before.logoOnDotMatrix,
      intakeTerms: before.intakeTerms,
      handoverTerms: before.handoverTerms,
    });
    core.emit('repair.changed');
    await waitFor(() =>
      expect((byTestId('repair.desk.slip.address') as HTMLTextAreaElement).value).toBe(
        'Jl. Ahmad Yani 12, Sorong',
      ),
    );
    expect((byTestId('repair.desk.slip.phone') as HTMLInputElement).value).toBe('0811 4800 123');

    fireEvent.click(byTestId('repair.desk.slip.save'));
    await screen.findByTestId('repair.desk.slip.saved');
    const saved = callsTo('repair.run').find((args) => args[1] === 'setPrintSettings');
    expect(saved?.[2]).toMatchObject({
      address: 'Jl. Ahmad Yani 12, Sorong',
      phone: '0811 4800 123',
    });
  });

  it('opens from the person menu, as on the phone', async () => {
    core = new FakeCore(ready({ session: session(signedIn(TECH, [])) }));
    renderApp();
    fireEvent.pointerDown(await screen.findByTestId('desktop.person'), {
      button: 0,
      pointerType: 'mouse',
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pengaturan' }));
    await screen.findByTestId('desktop.settings.account');
  });

  it('asks before switching person with unsaved changes, and not on a second Settings click', async () => {
    core = new FakeCore(ready({ session: session(signedIn(OWNER, ALL)) }));
    renderApp();
    await openSettings('fees');
    fireEvent.change(await screen.findByTestId('repair.desk.fees.beforeWork'), {
      target: { value: '35.000' },
    });
    // Settings again, while on Settings, is not leaving: no question, and the edit stays guarded.
    fireEvent.click(byTestId('nav.settings'));
    expect(screen.queryByTestId('desktop.settings.discard')).toBeNull();

    fireEvent.pointerDown(byTestId('desktop.person'), { button: 0, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Ganti pengguna' }));
    await screen.findByTestId('desktop.settings.discard');
    fireEvent.click(byTestId('desktop.settings.discard.cancel'));
    expect((byTestId('repair.desk.fees.beforeWork') as HTMLInputElement).value).toBe('35.000');
  });

  it('asks before leaving a page with unsaved changes', async () => {
    core = new FakeCore(ready({ session: session(signedIn(OWNER, ALL)) }));
    renderApp();
    await openSettings('slip');
    fireEvent.change(await screen.findByTestId('repair.desk.slip.address'), {
      target: { value: 'Jl. Ahmad Yani 12, Sorong' },
    });
    fireEvent.click(byTestId('desktop.settings.nav.fees'));
    await screen.findByTestId('desktop.settings.discard');
    fireEvent.click(byTestId('desktop.settings.discard.cancel'));
    expect((byTestId('repair.desk.slip.address') as HTMLTextAreaElement).value).toBe(
      'Jl. Ahmad Yani 12, Sorong',
    );

    // Leaving Settings for the board asks too.
    fireEvent.click(byTestId('nav.repair'));
    fireEvent.click(await screen.findByTestId('desktop.settings.discard.confirm'));
    await screen.findByTestId('repair.desk.board');
  });
});
