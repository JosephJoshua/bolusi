// The shell's inputs, derived from the booted app + the LIVE sync client (task 89).
//
// PURE and NODE-SAFE BY CONSTRUCTION: every import here is `import type`, so this module pulls in no
// native code and can be unit-tested directly (shell-inputs.test.ts) — unlike Root.tsx, which
// transitively imports expo-location/expo-notifications and cannot load under Node. The reason it is
// a separate module rather than an inline block in Root is exactly that testability: review-50b caught
// a false "gated on a persisted deviceId" comment in this area, and the standing risk is the §2.11
// one — a refactor that quietly re-hardcodes `loopState: 'idle'` / `isOffline: true`. A test watches
// the difference between "reads the live loop" and "returns a literal".
import type { SyncLoopState, SyncState } from '@bolusi/core';

import type { DeviceStatus } from '../navigation/zone.js';
import type { SyncStatusInput } from '../screens/sync-status/model.js';

import type { Bootstrapped } from './bootstrap.js';
import type { SyncClient } from './sync-client.js';

/**
 * The Sync Status screen's input, built from the device's REAL `SyncState` and the LIVE loop.
 *
 * `state`, `loopState` and `isOffline` are all reads — `state` from `sync_state`, `loopState` from the
 * running `SyncLoop` (03 §10), `isOffline` from NetInfo. Before task 89 the latter two were literals
 * (`'idle'` / `true`); they were the honest values of a device with NO loop, but only as ASSERTIONS.
 * No `?? Date.now()` and no `?? 0` on this path (T-19).
 *
 * `pendingOperationCount` / `rejected` / `quarantined` / `media` remain `0`/`[]`: they are derived DB
 * queries (01 §5.2) whose values are all empty on a device with no ops, and a device cannot append an
 * op without a session, which needs enrollment. They become real reads alongside the notes module
 * (task 25) that first produces ops to count.
 */
export function syncInput(
  state: SyncState,
  loopState: SyncLoopState,
  isOffline: boolean,
  now: number,
): SyncStatusInput {
  return {
    state,
    loopState,
    pendingOperationCount: 0,
    pendingMediaCount: 0,
    rejected: [],
    quarantined: [],
    media: [],
    isOffline,
    manualSyncBusy: false,
    manualSyncError: null,
    now,
  };
}

/**
 * Derive the shell's device status + sync input from the booted app and the LIVE sync client.
 *
 * When a loop exists, every value is what it actually reports; when it does not, the honest no-loop
 * values of an unenrolled device. Both are reads, neither a literal. `device` is derived from the real
 * persisted identity — revocation (`syncDisabled`) beats an enrolled device, which beats unenrolled,
 * the ordering the zone gate's security tests pin.
 */
export function resolveShellInputs(
  app: Bootstrapped,
  sync: SyncClient | null,
  now: number,
): { device: DeviceStatus; sync: SyncStatusInput } {
  const syncState = sync !== null ? sync.syncState() : app.syncState;
  const loopState: SyncLoopState = sync !== null ? sync.state() : 'idle';
  const isOffline = sync !== null ? sync.isOffline() : true;
  const device: DeviceStatus = syncState.syncDisabled
    ? 'revoked'
    : app.deviceId !== null
      ? 'active'
      : 'unenrolled';
  return { device, sync: syncInput(syncState, loopState, isOffline, now) };
}
