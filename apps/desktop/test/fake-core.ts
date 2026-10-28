// The stand-in core the window tests run against: a state the test sets, repair calls answered
// from the seeded demo, and a log of every call.
import type { ActiveSession } from '@bolusi/core';
import type { SwitcherUser } from '@bolusi/device/models/switcher/model';
import { demoRepairRuntime } from '@bolusi/modules/repair/demo';
import { REPAIR_PERMISSION } from '@bolusi/modules/repair';
import { act } from '@testing-library/react';

import type { CoreState, SessionView } from '../src/core/api.js';
import type { Client } from '../src/main/rpc.js';

export const OWNER: SwitcherUser = {
  id: 'u-owner',
  name: 'Andi Pratama',
  photoMediaId: null,
  lastActiveAt: null,
  needsFirstPin: false,
  roleKeys: ['main_owner'],
};
export const TECH: SwitcherUser = {
  id: 'u-tech',
  name: 'Budi Santoso',
  photoMediaId: null,
  lastActiveAt: null,
  needsFirstPin: false,
  roleKeys: ['technician'],
};
export const ALL = Object.values(REPAIR_PERMISSION);

/** The stand-in core: a state the test sets, and a log of every call. */
export class FakeCore {
  state: CoreState;
  readonly calls: { method: string; args: unknown[] }[] = [];
  answers: Record<string, (...args: unknown[]) => unknown> = {};
  private readonly listeners = new Set<() => void>();
  /** The seeded repair data the core's repair calls answer from; a test can change it directly. */
  readonly demo = demoRepairRuntime('owner', { volume: 'sample' });
  private readonly events = new Map<string, Set<(payload: unknown) => void>>();

  constructor(state: CoreState) {
    this.state = state;
  }

  readonly client: Client = {
    call: <T>(method: string, ...args: readonly unknown[]): Promise<T> => {
      this.calls.push({ method, args: [...args] });
      const answer = this.answers[method];
      if (answer !== undefined) return Promise.resolve(answer(...args) as T);
      // Repair reads and writes come from the seeded demo; the first argument names the person.
      if (method === 'repair.query') {
        return this.demo.query(args[1] as never, args[2] as never) as Promise<T>;
      }
      if (method === 'repair.run') {
        return this.demo.run(args[1] as never, args[2] as never) as Promise<T>;
      }
      if (method === 'repair.technicians') return this.demo.technicians() as Promise<T>;
      if (method === 'money.query') {
        return this.demo.money.query(args[1] as never, args[2] as never) as Promise<T>;
      }
      if (method === 'repair.loadThumbnail') {
        return this.demo.loadThumbnail(args[1] as never) as Promise<T>;
      }
      if (method === 'repair.ticketSyncStatuses') {
        return this.demo.ticketSyncStatuses(args[1] as string[]) as Promise<T>;
      }
      return Promise.resolve(undefined as T);
    },
    on: (event: string, listener: (payload: unknown) => void) => {
      const listeners = this.events.get(event) ?? new Set();
      this.events.set(event, listeners);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => undefined,
  };

  set(next: Partial<CoreState>): void {
    this.state = { ...this.state, ...next };
    act(() => {
      for (const listener of this.listeners) listener();
    });
  }

  /** A push from the core, such as `repair.changed` when another device's change syncs in. */
  emit(event: string, payload?: unknown): void {
    act(() => {
      for (const listener of this.events.get(event) ?? []) listener(payload);
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

export function session(over: Partial<SessionView> = {}): SessionView {
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

export function ready(over: Partial<CoreState> = {}): CoreState {
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

export const signedIn = (
  user: SwitcherUser,
  permissions: readonly string[],
): Partial<SessionView> => ({
  active: { sessionId: `s-${user.id}`, userId: user.id } satisfies ActiveSession,
  permissions,
});
