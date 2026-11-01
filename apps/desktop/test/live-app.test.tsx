// The window over the offline core: which screen shows for each state the core reports, and what
// the window asks the core for. The core here is a stand-in that answers repair calls from the
// seeded demo and records everything else, so the gate and the calls are tested without a process.
import type { SyncStatusInput } from '@bolusi/device/models/sync-status/model';
import { initI18n } from '@bolusi/i18n';
import enRepairCatalog from '@bolusi/modules/repair/i18n/en.json';
import idRepairCatalog from '@bolusi/modules/repair/i18n/id.json';
import { REPAIR_PERMISSION, emptyIntakeDraft } from '@bolusi/modules/repair';
import { registerRepairCatalog } from '@bolusi/modules/repair/desktop';
import { TooltipProvider } from '@bolusi/ui-web';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function renderApp(): void {
  render(
    <TooltipProvider>
      <App />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  initI18n({ locale: 'id' });
  registerRepairCatalog({ id: idRepairCatalog, en: enRepairCatalog });
});
afterEach(cleanup);

describe('the PC over the offline core', () => {
  it('says the data is opening, then that it could not be opened', () => {
    core = new FakeCore({ ...ready(), phase: 'booting', session: null });
    renderApp();
    expect(screen.getByTestId('boot')).toBeTruthy();
    core.set({ phase: 'failed', bootError: 'SQLITE_CORRUPT' });
    expect(screen.getByTestId('boot.failed').textContent).toContain('belum bisa dibuka');
    // The reason is for support, not for the counter.
    expect(screen.getByTestId('boot.failed').textContent).not.toContain('SQLITE');
  });

  it('registers an unregistered PC, keeping the owner sign-in in the core', async () => {
    core = new FakeCore(ready({ device: 'unenrolled', session: null, deviceInfo: null }));
    core.answers['enrollment.login'] = () => ({
      tenantId: 't-1',
      tenantName: 'Bolusi',
      user: { id: 'u-owner', name: 'Andi Pratama' },
      stores: [{ id: 'st-1', name: 'Toko Sorong Kota' }],
      controlSession: '',
    });
    renderApp();
    fireEvent.change(screen.getByTestId('enrol.identifier'), { target: { value: 'andi' } });
    fireEvent.change(screen.getByTestId('enrol.password'), { target: { value: 'rahasia-toko' } });
    fireEvent.click(screen.getByTestId('enrol.submit'));
    await screen.findByTestId('enrol.confirm');
    const enrolCalls = () => core.calls.filter((call) => call.method !== 'enrollment.heldPhone');
    expect(enrolCalls()[0]).toEqual({
      method: 'enrollment.login',
      args: [{ loginIdentifier: 'andi', password: 'rahasia-toko' }],
    });
    fireEvent.change(screen.getByTestId('enrol.deviceName'), { target: { value: 'PC Kasir' } });
    fireEvent.click(screen.getByTestId('enrol.bind'));
    await screen.findByTestId('enrol.done');
    expect(enrolCalls()[1]).toEqual({
      method: 'enrollment.enroll',
      args: [{ storeId: 'st-1', deviceName: 'PC Kasir' }],
    });
    fireEvent.click(screen.getByTestId('enrol.finish'));
    expect(core.methods()).toContain('enrollment.finish');
  });

  it('re-registers a PC into its own store and shows whose unsent changes it carries over', async () => {
    core = new FakeCore(ready({ device: 'revoked', session: null }));
    core.answers['enrollment.heldPhone'] = () => ({
      storeId: 'st-2',
      storeName: 'Toko Sorong Kota',
      replacesDeviceId: null,
      unsynced: [
        { userId: 'u-siti', name: 'Siti Rahayu', count: 3, types: ['repair.ticket_opened'] },
        { userId: 'u-gone', name: null, count: 1, types: ['repair.work_started'] },
      ],
    });
    core.answers['enrollment.login'] = () => ({
      tenantId: 't-1',
      tenantName: 'Bolusi',
      user: { id: 'u-owner', name: 'Andi Pratama' },
      stores: [
        { id: 'st-1', name: 'Toko Jayapura' },
        { id: 'st-2', name: 'Toko Sorong Kota' },
      ],
      controlSession: '',
    });
    renderApp();
    await waitFor(() => expect(core.methods()).toContain('enrollment.heldPhone'));
    fireEvent.change(screen.getByTestId('enrol.identifier'), { target: { value: 'andi' } });
    fireEvent.change(screen.getByTestId('enrol.password'), { target: { value: 'rahasia-toko' } });
    fireEvent.click(screen.getByTestId('enrol.submit'));
    await screen.findByTestId('enrol.confirm');
    // Its records belong to its own store, so that is the only one offered.
    expect(screen.getByTestId('enrol.store').textContent).toContain('Toko Sorong Kota');
    expect(screen.queryByTestId('enrol.stores')).toBeNull();
    expect(screen.getByTestId('enrol.unsynced.u-siti').textContent).toContain('3 perubahan');
    expect(screen.getByTestId('enrol.unsynced.u-gone').textContent).toContain('Karyawan lama');
  });

  it('shows a blocked PC the registration again, whatever session was open', () => {
    core = new FakeCore(ready({ device: 'revoked', session: session(signedIn(OWNER, ALL)) }));
    renderApp();
    expect(screen.getByTestId('enrol.credentials').textContent).toContain('diblokir');
    expect(screen.queryByTestId('desktop.shell')).toBeNull();
  });

  it('offers to register a PC the server forgot again, from the sync panel', async () => {
    const forgotten: SyncStatusInput = {
      state: {
        cursor: 12,
        devicesDirectoryVersion: 1,
        lastSuccessfulSyncAt: 0,
        lastPushAt: 0,
        lastPullAt: 0,
        lastServerTime: 0,
        lastServerTimeReceivedAt: 0,
        pushHalted: false,
        syncDisabled: true,
        syncDisabledReason: 'device_unrecognised',
        lastSyncError: null,
        backoffUntil: null,
        tokenRejectedSince: 0,
        tokenRejectedCount: 3,
        readSet: null,
        backfill: null,
      },
      loopState: 'idle',
      pendingOperationCount: 4,
      pendingMediaCount: 0,
      rejected: [],
      quarantined: [],
      media: [],
      isOffline: false,
      manualSyncBusy: false,
      manualSyncError: null,
      firstSync: null,
      now: 60_000,
    };
    // Work goes on while the PC is forgotten: the counter stays open.
    core = new FakeCore(
      ready({ device: 'unrecognised', session: session(signedIn(OWNER, ALL)), sync: forgotten }),
    );
    renderApp();
    await screen.findByTestId('desktop.shell');
    fireEvent.click(screen.getByTestId('desktop.sync'));
    // Sending cannot help, so registering again is the one action offered.
    expect(screen.queryByTestId('desktop.sync.now')).toBeNull();
    expect(screen.getByTestId('desktop.sync.dialog').textContent).toContain(
      'Server tidak mengenali komputer ini lagi',
    );
    fireEvent.click(screen.getByTestId('desktop.sync.reenrol'));
    expect(await screen.findByTestId('enrol.credentials')).toBeTruthy();
    expect(screen.queryByTestId('desktop.shell')).toBeNull();
  });

  it('says how many of a servisan’s changes were refused, and opens the sync panel from there', async () => {
    const refused = (opId: string) => ({
      opId,
      type: 'repair.work_started',
      at: 0,
      rejectionCode: 'RULE_VIOLATED',
      rejectionReason: 'repair.refusal.cancelled',
      subject: 'Servisan K7Q-0012',
    });
    core = new FakeCore(
      ready({
        session: session(signedIn(OWNER, ALL)),
        sync: {
          state: {
            cursor: 12,
            devicesDirectoryVersion: 1,
            lastSuccessfulSyncAt: 0,
            lastPushAt: 0,
            lastPullAt: 0,
            lastServerTime: 0,
            lastServerTimeReceivedAt: 0,
            pushHalted: false,
            syncDisabled: false,
            syncDisabledReason: null,
            lastSyncError: null,
            backoffUntil: null,
            tokenRejectedSince: null,
            tokenRejectedCount: 0,
            readSet: null,
            backfill: null,
          },
          loopState: 'idle',
          pendingOperationCount: 0,
          pendingMediaCount: 0,
          rejected: [refused('op-1'), refused('op-2')],
          quarantined: [],
          media: [],
          isOffline: false,
          manualSyncBusy: false,
          manualSyncError: null,
          firstSync: null,
          now: 60_000,
        },
      }),
    );
    core.answers['repair.ticketSyncStatuses'] = () => ({ 't-1': ['rejected', 'rejected'] });
    renderApp();
    fireEvent.click(await screen.findByText('Yohanis Wenda'));
    await screen.findByText('2 perubahan ditolak server.');
    fireEvent.click(screen.getByRole('button', { name: 'Cek status sinkron' }));
    const panel = await screen.findByTestId('desktop.sync.dialog');
    expect(panel.textContent).toContain('Ditolak server (2)');
    expect(panel.textContent).toContain('Perubahan ini tidak berlaku.');
  });

  it('signs a person in with their PIN and offers the owner a new intake', async () => {
    core = new FakeCore(ready());
    core.answers['session.submitPin'] = (userId) => {
      core.session(signedIn(OWNER, ALL));
      return { kind: 'opened', session: { sessionId: 's', userId } };
    };
    renderApp();
    await waitFor(() => expect(core.methods()).toContain('session.refresh'));
    fireEvent.click(screen.getByText('Andi Pratama'));
    for (const key of '314159') fireEvent.keyDown(window, { key });
    await screen.findByTestId('desktop.shell');
    expect(core.calls.find((call) => call.method === 'session.submitPin')?.args).toEqual([
      'u-owner',
      '314159',
    ]);
    // The runtime takes the person's grants from the core (this was once lost, hiding the button).
    await screen.findByTestId('repair.desk.board.newIntake');
    // Every repair call names who it is for; the core refuses it for anyone else.
    const query = core.calls.find((call) => call.method === 'repair.query');
    expect(query?.args[0]).toBe('u-owner');
  });

  it('takes the store’s payment methods from the core, for the person signed in', async () => {
    core = new FakeCore(ready());
    core.answers['session.submitPin'] = (userId) => {
      core.session(signedIn(OWNER, ALL));
      return { kind: 'opened', session: { sessionId: 's', userId } };
    };
    renderApp();
    await waitFor(() => expect(core.methods()).toContain('session.refresh'));
    fireEvent.click(screen.getByText('Andi Pratama'));
    for (const key of '314159') fireEvent.keyDown(window, { key });
    fireEvent.click(await screen.findByTestId('repair.desk.board.newIntake'));
    await screen.findByTestId('repair.desk.intake');
    await waitFor(() =>
      expect(core.calls.find((call) => call.method === 'money.query')?.args).toEqual([
        'u-owner',
        'paymentAccounts',
        {},
      ]),
    );
  });

  it('hides a new intake from a technician without the grant', async () => {
    core = new FakeCore(
      ready({ session: session(signedIn(TECH, [REPAIR_PERMISSION.read, REPAIR_PERMISSION.work])) }),
    );
    renderApp();
    await screen.findByTestId('repair.desk.board');
    expect(screen.queryByTestId('repair.desk.board.newIntake')).toBeNull();
  });

  it('says a wrong PIN and keeps the pad', async () => {
    core = new FakeCore(ready());
    core.answers['session.submitPin'] = () => ({
      kind: 'wrong',
      state: 'ok',
      lockedOut: false,
    });
    renderApp();
    fireEvent.click(screen.getByText('Budi Santoso'));
    for (const key of '000000') fireEvent.keyDown(window, { key });
    await waitFor(() => expect(screen.getByTestId('pin.message').textContent).not.toBe(''));
    expect(screen.getByTestId('pin.message').getAttribute('role')).toBe('alert');
    expect(screen.queryByTestId('desktop.shell')).toBeNull();
  });

  it('locks to the people list with no way back into the last person', async () => {
    core = new FakeCore(ready({ session: session(signedIn(OWNER, ALL)) }));
    renderApp();
    await screen.findByTestId('desktop.shell');
    core.session({ active: null, locked: true, lockReason: 'manual_lock', permissions: [] });
    expect(screen.getByTestId('switcher').textContent).toContain('Siapa yang pakai?');
    expect(screen.queryByTestId('switcher.back')).toBeNull();
    expect(screen.queryByTestId('desktop.shell')).toBeNull();
  });

  it('switches person from the menu and goes back without a PIN', async () => {
    core = new FakeCore(ready({ session: session(signedIn(OWNER, ALL)) }));
    renderApp();
    await screen.findByTestId('desktop.shell');
    fireEvent.pointerDown(screen.getByTestId('desktop.person'), {
      button: 0,
      pointerType: 'mouse',
    });
    fireEvent.click(await screen.findByText('Ganti pengguna'));
    expect(screen.getByTestId('switcher')).toBeTruthy();
    fireEvent.click(screen.getByTestId('switcher.back'));
    expect(screen.getByTestId('desktop.shell')).toBeTruthy();
  });

  it('keeps a half-done intake on the PC, naming who started it, for whoever signs in next', async () => {
    core = new FakeCore(ready({ session: session(signedIn(OWNER, ALL)) }));
    renderApp();
    await screen.findByTestId('repair.desk.board.newIntake');
    fireEvent.keyDown(window, { key: 'F2' });
    fireEvent.change(await screen.findByTestId('repair.desk.intake.name'), {
      target: { value: 'Yakobus Mandowen' },
    });
    const writes = core.calls.filter((call) => call.method === 'session.updateDeviceDraft');
    const [moduleId, kept] = writes.at(-1)!.args as [string, Record<string, unknown>];
    expect(moduleId).toBe('repair');
    expect(kept['startedBy']).toEqual({ userId: OWNER.id, name: OWNER.name });
    expect(JSON.stringify(kept)).toContain('Yakobus Mandowen');
    // Not in the owner's own workspace: it belongs to the PC.
    expect(core.calls.some((call) => call.method === 'session.updateWorkspace')).toBe(false);

    // The same person back after a lock: the intake reopens, with no "started by" line.
    core.session({ active: null, locked: true, permissions: [] });
    core.session({ ...signedIn(OWNER, ALL), locked: false, deviceDrafts: { repair: kept } });
    expect(((await screen.findByTestId('repair.desk.intake.name')) as HTMLInputElement).value).toBe(
      'Yakobus Mandowen',
    );
    expect(screen.queryByTestId('repair.desk.intake.startedBy')).toBeNull();

    // A colleague: it waits on the board, and carrying on says whose it was.
    core.session({ active: null, locked: true, permissions: [] });
    core.session({ ...signedIn(TECH, ALL), locked: false, deviceDrafts: { repair: kept } });
    const resume = await screen.findByTestId('repair.desk.board.newIntake');
    expect(resume.textContent).toContain('Lanjutkan servisan baru');
    fireEvent.click(resume);
    expect(((await screen.findByTestId('repair.desk.intake.name')) as HTMLInputElement).value).toBe(
      'Yakobus Mandowen',
    );
    expect(screen.getByTestId('repair.desk.intake.startedBy').textContent).toBe(
      `Dimulai oleh ${OWNER.name}`,
    );
    // Their changes keep the starter's name.
    fireEvent.change(screen.getByTestId('repair.desk.intake.name'), {
      target: { value: 'Yakobus M.' },
    });
    const after = core.calls.filter((call) => call.method === 'session.updateDeviceDraft');
    const latest = after.at(-1)!.args[1] as Record<string, unknown>;
    expect(latest['startedBy']).toEqual({ userId: OWNER.id, name: OWNER.name });
    expect(JSON.stringify(latest)).toContain('Yakobus M.');
  });

  it("brings back an intake an older version kept in the person's own workspace, and moves it to the PC", async () => {
    const draft = { ...emptyIntakeDraft(), customer: { kind: 'new', name: 'Ester', phone: '' } };
    const workspace = { ownerUserId: OWNER.id, route: 'home', drafts: { repair: draft } };
    core = new FakeCore(
      ready({ session: session({ ...signedIn(OWNER, ALL), workspace: workspace as never }) }),
    );
    renderApp();
    expect(((await screen.findByTestId('repair.desk.intake.name')) as HTMLInputElement).value).toBe(
      'Ester',
    );
    await waitFor(() => {
      const cleared = core.calls.find((call) => call.method === 'session.updateWorkspace');
      expect((cleared?.args[0] as { drafts: Record<string, unknown> }).drafts['repair']).toBeNull();
    });
    const moved = core.calls.find((call) => call.method === 'session.updateDeviceDraft');
    expect(JSON.stringify(moved?.args[1])).toContain('Ester');
  });

  it("never shows one person's draft to another", async () => {
    const draft = { ownerUserId: 'u-owner', route: 'home', drafts: { repair: { name: 'x' } } };
    core = new FakeCore(
      ready({ session: session({ ...signedIn(TECH, ALL), workspace: draft as never }) }),
    );
    renderApp();
    await screen.findByTestId('repair.desk.board');
    expect(screen.queryByTestId('repair.desk.intake')).toBeNull();
  });
});

describe('setting up a newly registered PC', () => {
  it('opens the setup for the owner who registered it, then the counter once it is done', async () => {
    core = new FakeCore(
      ready({ setupFor: OWNER.id, session: session({ ...signedIn(OWNER, ALL) }) }),
    );
    renderApp();
    await screen.findByTestId('desktop.setup.printer');
    expect(screen.getByTestId('desktop.setup.step').textContent).toBe('Langkah 1 dari 2');
    fireEvent.click(screen.getByTestId('desktop.setup.next'));
    await screen.findByTestId('desktop.setup.capture');
    // No webcam here: photos and signatures come from a store phone.
    expect((await screen.findByTestId('desktop.setup.phone')).textContent).toContain('HP toko');
    expect(screen.getByTestId('desktop.setup.signature').textContent).toContain('HP toko');
    fireEvent.click(screen.getByTestId('desktop.setup.back'));
    await screen.findByTestId('desktop.setup.printer');
    fireEvent.click(screen.getByTestId('desktop.setup.next'));
    fireEvent.click(await screen.findByTestId('desktop.setup.next'));
    await screen.findByTestId('desktop.setup.done');
    expect(screen.getByTestId('desktop.setup.done.photos').textContent).toContain('HP toko');
    expect(core.methods()).not.toContain('device.finishSetup');
    fireEvent.click(screen.getByTestId('desktop.setup.start'));
    await screen.findByTestId('repair.desk.board');
    expect(core.methods()).toContain('device.finishSetup');
  });

  it('can be put off, and opened again from Settings', async () => {
    core = new FakeCore(
      ready({ setupFor: OWNER.id, session: session({ ...signedIn(OWNER, ALL) }) }),
    );
    renderApp();
    fireEvent.click(await screen.findByTestId('desktop.setup.later'));
    await screen.findByTestId('repair.desk.board');
    expect(core.methods()).toContain('device.finishSetup');
    core.set({ setupFor: null });
    fireEvent.click(screen.getByTestId('nav.settings'));
    fireEvent.click(await screen.findByTestId('desktop.settings.nav.computer'));
    fireEvent.click(await screen.findByTestId('desktop.settings.setup'));
    await screen.findByTestId('desktop.setup.printer');
  });

  it('lists the store basics still missing, each opening its setting', async () => {
    core = new FakeCore(
      ready({ setupFor: OWNER.id, session: session({ ...signedIn(OWNER, ALL) }) }),
    );
    renderApp();
    fireEvent.click(await screen.findByTestId('desktop.setup.next'));
    fireEvent.click(await screen.findByTestId('desktop.setup.next'));
    await screen.findByTestId('desktop.setup.done');
    fireEvent.click(await screen.findByTestId('desktop.setup.basics.logo'));
    await screen.findByTestId('repair.desk.slip');
    // Going to fill one in ends the setup, as starting would.
    expect(core.methods()).toContain('device.finishSetup');
  });

  it('does not stop anyone else with it', async () => {
    core = new FakeCore(
      ready({ setupFor: OWNER.id, session: session({ ...signedIn(TECH, ALL) }) }),
    );
    renderApp();
    await screen.findByTestId('repair.desk.board');
    expect(screen.queryByTestId('desktop.setup.printer')).toBeNull();
  });
});
