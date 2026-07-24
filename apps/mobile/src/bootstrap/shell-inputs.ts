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
import { NO_SYNC_STATUS_READS, type SyncStatusReads } from './sync-status-reads.js';
import type { SyncClient } from './sync-client.js';

/**
 * The Sync Status screen's input, built from the device's REAL `SyncState`, the LIVE loop, and the
 * derived reads (01 §5.2).
 *
 * `state`, `loopState` and `isOffline` are all reads — `state` from `sync_state`, `loopState` from the
 * running `SyncLoop` (03 §10), `isOffline` from NetInfo. Before task 89 the latter two were literals
 * (`'idle'` / `true`); they were the honest values of a device with NO loop, but only as ASSERTIONS.
 * No `?? Date.now()` and no `?? 0` on this path (T-19).
 *
 * `pendingOperationCount` / `rejected` / `media` WERE literals too, with a comment promising they
 * would become reads "alongside the notes module (task 25) that first produces ops to count". Notes
 * landed and they did not, so §8.4's rejected list and media queue could not render on any device at
 * any state — and the two controls on those rows (`onOpenRejected`, `onRetryMedia`) were therefore
 * unpressable as well as unwired. `reads` closes that (task 130); `sync-status-reads.ts` owns the SQL.
 *
 * `quarantined` STAYS `[]`, and that is a different fact rather than the same one unfixed: nothing on
 * this client persists a held-out pull batch (api/01-sync §4 quarantine has no client table — grep
 * `quarantin` across `packages/db-client` finds no column). An empty list is what this device
 * genuinely knows. Filed as its own finding rather than papered over here.
 */
export function syncInput(
  state: SyncState,
  loopState: SyncLoopState,
  isOffline: boolean,
  now: number,
  reads: SyncStatusReads = NO_SYNC_STATUS_READS,
): SyncStatusInput {
  return {
    state,
    loopState,
    pendingOperationCount: reads.pendingOperationCount,
    pendingMediaCount: reads.pendingMediaCount,
    rejected: reads.rejected,
    quarantined: [],
    media: reads.media,
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
  reads: SyncStatusReads = NO_SYNC_STATUS_READS,
): { device: DeviceStatus; sync: SyncStatusInput } {
  const syncState = sync !== null ? sync.syncState() : app.syncState;
  const loopState: SyncLoopState = sync !== null ? sync.state() : 'idle';
  const isOffline = sync !== null ? sync.isOffline() : true;
  const device: DeviceStatus = syncState.syncDisabled
    ? 'revoked'
    : app.deviceId !== null
      ? 'active'
      : 'unenrolled';
  return { device, sync: syncInput(syncState, loopState, isOffline, now, reads) };
}
