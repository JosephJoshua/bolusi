// The window over the offline core: which screen shows for each state the core reports, and what
// the window asks the core for. The core here is a stand-in that answers repair calls from the
// seeded demo and records everything else, so the gate and the calls are tested without a process.
import type { ActiveSession } from '@bolusi/core';
import type { SyncStatusInput } from '@bolusi/device/models/sync-status/model';
import type { SwitcherUser } from '@bolusi/device/models/switcher/model';
import { initI18n } from '@bolusi/i18n';
import { demoRepairRuntime } from '@bolusi/modules/repair/demo';
import enRepairCatalog from '@bolusi/modules/repair/i18n/en.json';
import idRepairCatalog from '@bolusi/modules/repair/i18n/id.json';
import { REPAIR_PERMISSION } from '@bolusi/modules/repair';
import { registerRepairCatalog } from '@bolusi/modules/repair/desktop';
import { TooltipProvider } from '@bolusi/ui-web';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CoreState, SessionView } from '../src/core/api.js';
import type { Client } from '../src/main/rpc.js';
import type { CoreView } from '../src/renderer/use-core.js';

const OWNER: SwitcherUser = {
  id: 'u-owner',
  name: 'Andi Pratama',
  photoMediaId: null,
  lastActiveAt: null,
  needsFirstPin: false,
  roleKeys: ['main_owner'],
};
const TECH: SwitcherUser = {
  id: 'u-tech',
  name: 'Budi Santoso',
  photoMediaId: null,
  lastActiveAt: null,
  needsFirstPin: false,
  roleKeys: ['technician'],
};
const ALL = Object.values(REPAIR_PERMISSION);

/** The stand-in core: a state the test sets, and a log of every call. */
class FakeCore {
  state: CoreState;
  readonly calls: { method: string; args: unknown[] }[] = [];
  answers: Record<string, (...args: unknown[]) => unknown> = {};
  private readonly listeners = new Set<() => void>();
  private readonly demo = demoRepairRuntime('owner', { volume: 'sample' });

  constructor(state: CoreState) {
    this.state = state;
  }

  readonly client: Client = {
    call: <T,>(method: string, ...args: readonly unknown[]): Promise<T> => {
      this.calls.push({ method, args: [...args] });
      const answer = this.answers[method];
      if (answer !== undefined) return Promise.resolve(answer(...args) as T);
      // Repair reads and writes come from the seeded demo; the first argument names the person.
      if (method === 'repair.query') {
        return this.demo.query(args[1] as never, args[2] as never) as Promise<T>;
      }
      if (method === 'repair.technicians') return this.demo.technicians() as Promise<T>;
      if (method === 'money.query') {
        return this.demo.money.query(args[1] as never, args[2] as never) as Promise<T>;
      }
      if (method === 'repair.ticketSyncStatuses') {
        return this.demo.ticketSyncStatuses(args[1] as string[]) as Promise<T>;
      }
      return Promise.resolve(undefined as T);
    },
    on: () => () => undefined,
    close: () => undefined,
  };

  set(next: Partial<CoreState>): void {
    this.state = { ...this.state, ...next };
    act(() => {
      for (const listener of this.listeners) listener();
    });
  }

  session(next: Partial<SessionView>): void {
    this.set({ session: { ...this.state.session!, ...next } });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }
}

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

function session(over: Partial<SessionView> = {}): SessionView {
  return {
    active: null,
    users: [OWNER, TECH],
    usersError: null,
    pinRows: {},
    locked: false,
    lockReason: null,
    workspace: null,
    canUnlock: true,
    canReset: true,
    canManageStaff: true,
    tenantAdmin: true,
    permissions: [],
    colleaguePermissions: {},
    ...over,
  };
}

function ready(over: Partial<CoreState> = {}): CoreState {
  return {
    phase: 'ready',
    bootError: null,
    device: 'active',
    deviceInfo: {
      deviceId: 'd-1',
      deviceName: 'PC Kasir',
      storeName: 'Toko Sorong Kota',
      tenantName: 'Bolusi',
      platform: 'windows',
      appVersion: '0.1.0',
    },
    session: session(),
    sync: null,
    ...over,
  };
}

const signedIn = (user: SwitcherUser, permissions: readonly string[]): Partial<SessionView> => ({
  active: { sessionId: `s-${user.id}`, userId: user.id } satisfies ActiveSession,
  permissions,
});

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

  it("keeps a half-done intake in the person's own workspace and brings it back", async () => {
    core = new FakeCore(ready({ session: session(signedIn(OWNER, ALL)) }));
    renderApp();
    await screen.findByTestId('repair.desk.board.newIntake');
    fireEvent.keyDown(window, { key: 'F2' });
    fireEvent.change(await screen.findByTestId('repair.desk.intake.name'), {
      target: { value: 'Yakobus Mandowen' },
    });
    const writes = core.calls.filter((call) => call.method === 'session.updateWorkspace');
    const last = writes.at(-1)?.args[0] as {
      ownerUserId: string;
      drafts: Record<string, { customerName?: string }>;
    };
    expect(last.ownerUserId).toBe('u-owner');
    expect(JSON.stringify(last.drafts['repair'])).toContain('Yakobus Mandowen');

    // A lock, and the same person back: the core hands the workspace back and the intake reopens.
    core.session({ active: null, locked: true, permissions: [] });
    core.session({ ...signedIn(OWNER, ALL), locked: false, workspace: last as never });
    expect(((await screen.findByTestId('repair.desk.intake.name')) as HTMLInputElement).value).toBe(
      'Yakobus Mandowen',
    );
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
