// SyncStatusScreen disables "Sync now" when the device is revoked (design-system §8.4 item 3) — this
// file mounts the real screen to prove `manualSync`'s verdict reaches the button's `disabled` prop.
//
// ── WHY THIS FILE EXISTS (task 69) ──────────────────────────────────────────────────────────────
// `model.test.ts` covers `manualSync(input)` — it can prove the FUNCTION returns `disabled` for a
// revoked device. It cannot prove `SyncStatusScreen` performs the composition it assumes:
// `<Button … disabled={sync.kind === 'disabled'}>`. Break that one prop and a revoked device shows a
// live "Sync now" button that can never do anything — the app looks broken rather than blocked, on a
// screen whose whole job (model.ts's thesis) is to be the app's honesty surface — while every model
// assertion stays green because nothing renders the screen.
//
// The assertion reads the button's public `disabled` prop, never its label — T-4. This mirrors
// `EnrollmentScreen.test.tsx`'s `enroll-bind` disabled check.
import { type SyncLoopState, type SyncState } from '@bolusi/core';
import { describe, expect, test, vi } from 'vitest';

import { render } from '../../../../../packages/ui/test/render.js';

import { SyncStatusScreen } from './SyncStatusScreen.js';
import { manualSync, type SyncStatusInput } from './model.js';

const NOW = 1_700_000_000_000;

function state(overrides: Partial<SyncState> = {}): SyncState {
  return {
    cursor: 0,
    devicesDirectoryVersion: 0,
    lastSuccessfulSyncAt: NOW,
    lastPushAt: null,
    lastPullAt: null,
    pushHalted: false,
    syncDisabled: false,
    syncDisabledReason: null,
    lastSyncError: null,
    backoffUntil: null,
    lastServerTime: NOW,
    lastServerTimeReceivedAt: NOW,
    ...overrides,
  };
}

function input(overrides: Partial<SyncStatusInput> = {}): SyncStatusInput {
  return {
    state: state(),
    loopState: 'idle' satisfies SyncLoopState,
    pendingOperationCount: 0,
    pendingMediaCount: 0,
    rejected: [],
    quarantined: [],
    media: [],
    isOffline: false,
    manualSyncBusy: false,
    manualSyncError: null,
    now: NOW,
    ...overrides,
  };
}

function renderSync(over: Partial<SyncStatusInput> = {}) {
  return render(
    <SyncStatusScreen
      input={input(over)}
      currentUser={{ id: 'user-1', initials: 'PO' }}
      onBack={vi.fn()}
      onSyncNow={vi.fn()}
      onOpenRejected={vi.fn()}
      onRetryMedia={vi.fn()}
      onOpenSwitcher={vi.fn()}
    />,
  );
}

const REVOKED = { syncDisabled: true, syncDisabledReason: 'device_revoked' as const };

describe('the "Sync now" button is wired to manualSync`s verdict (design-system §8.4 item 3)', () => {
  test('a revoked device disables the button — a dead loop must not offer a live control', () => {
    const revokedInput = input({ state: state(REVOKED) });
    // T-14b: pin the fixture against the model, so a change to `manualSync` cannot leave this test
    // rendering a `ready` button while claiming to test the disabled one.
    expect(manualSync(revokedInput).kind).toBe('disabled');

    const screen = renderSync({ state: state(REVOKED) });
    expect(screen.get('sync-now').props['disabled']).toBe(true);
  });

  test('POSITIVE CONTROL: a healthy device leaves the button ENABLED — disabled is driven by state', () => {
    // Without this, the test above would pass on a screen that disabled the button unconditionally,
    // an app that can never manually sync. Offline is deliberately still ENABLED (model.ts): pressing
    // it is how a user finds out the connection is back.
    expect(manualSync(input()).kind).toBe('ready');

    const screen = renderSync();
    expect(screen.get('sync-now').props['disabled']).toBe(false);
  });
});
