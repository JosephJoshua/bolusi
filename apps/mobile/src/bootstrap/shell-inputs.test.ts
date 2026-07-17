// resolveShellInputs (task 89) — the guard that `loopState` / `isOffline` / `SyncState` are READ FROM
// THE LIVE LOOP, not literals. review-50b caught a false comment in this exact area; the standing risk
// is a refactor that re-hardcodes `'idle'` / `true`. These tests watch the difference.
import type { SyncLoopState, SyncState } from '@bolusi/core';
import { describe, expect, test } from 'vitest';

import type { Bootstrapped } from './bootstrap.js';
import { resolveShellInputs } from './shell-inputs.js';
import type { SyncClient } from './sync-client.js';

function syncState(over: Partial<SyncState> = {}): SyncState {
  return {
    cursor: 0,
    devicesDirectoryVersion: 0,
    lastSuccessfulSyncAt: null,
    lastPushAt: null,
    lastPullAt: null,
    lastServerTime: null,
    lastServerTimeReceivedAt: null,
    pushHalted: false,
    syncDisabled: false,
    syncDisabledReason: null,
    lastSyncError: null,
    backoffUntil: null,
    ...over,
  };
}

/** resolveShellInputs reads only `deviceId` and `syncState`; the rest of Bootstrapped is not exercised. */
function bootstrapped(deviceId: string | null, state: SyncState): Bootstrapped {
  return { deviceId, syncState: state } as unknown as Bootstrapped;
}

function fakeClient(over: {
  state?: SyncLoopState;
  offline?: boolean;
  syncState?: SyncState;
}): SyncClient {
  return {
    start: () => Promise.resolve(),
    requestManual: () => undefined,
    stop: () => undefined,
    state: () => over.state ?? 'idle',
    isOffline: () => over.offline ?? true,
    syncState: () => over.syncState ?? syncState(),
    subscribe: () => () => undefined,
    surfacings: () => [],
    settle: () => Promise.resolve(),
  };
}

describe('resolveShellInputs — live reads, never literals (task 89)', () => {
  test('no client (unenrolled): the honest no-loop values, device = unenrolled', () => {
    const shell = resolveShellInputs(bootstrapped(null, syncState()), null, 1000);
    expect(shell.device).toBe('unenrolled');
    expect(shell.sync.loopState).toBe('idle');
    expect(shell.sync.isOffline).toBe(true);
    expect(shell.sync.state.lastSuccessfulSyncAt).toBeNull();
  });

  test('a LIVE client drives loopState + isOffline — NOT the old literals', () => {
    // THE FALSIFICATION TARGET: hardcoded `loopState: 'idle'` / `isOffline: true` would fail this.
    const app = bootstrapped('device-1', syncState());
    const client = fakeClient({
      state: 'pushing',
      offline: false,
      syncState: syncState({ lastSuccessfulSyncAt: 5000 }),
    });
    const shell = resolveShellInputs(app, client, 9000);
    expect(shell.sync.loopState).toBe('pushing'); // read from the loop, not 'idle'
    expect(shell.sync.isOffline).toBe(false); // read from NetInfo, not true
    expect(shell.device).toBe('active'); // enrolled, from the real deviceId
  });

  test('the SyncState comes from the CLIENT, not app.syncState — the banner clears from the live column', () => {
    // app.syncState is the boot snapshot (STALE: null); the client reports a fresh sync. If Root read
    // app.syncState instead of client.syncState(), the banner would never clear — this catches that.
    const app = bootstrapped('device-1', syncState({ lastSuccessfulSyncAt: null }));
    const client = fakeClient({ syncState: syncState({ lastSuccessfulSyncAt: 8000 }) });
    const shell = resolveShellInputs(app, client, 9000);
    expect(shell.sync.state.lastSuccessfulSyncAt).toBe(8000);
  });

  test('a revoked device (syncDisabled) resolves device = revoked — revocation beats enrolled', () => {
    const app = bootstrapped('device-1', syncState({ syncDisabled: true }));
    const client = fakeClient({ syncState: syncState({ syncDisabled: true }) });
    expect(resolveShellInputs(app, client, 1000).device).toBe('revoked');
  });
});
