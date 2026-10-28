// The title bar's sync status reads its age again as time passes, not only when a new snapshot
// arrives: a server that hangs sends none, and "baru saja" must still become "5 menit lalu".
import type { SyncState } from '@bolusi/core';
import type { SyncStatusInput } from '@bolusi/device/models/sync-status/model';
import { initI18n } from '@bolusi/i18n';
import { TooltipProvider } from '@bolusi/ui-web';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';

import { SyncStatusButton } from '../src/renderer/SyncStatus.js';

const NOW = 1_700_000_000_000;

beforeAll(() => {
  initI18n({ locale: 'id' });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function input(): SyncStatusInput {
  const state: SyncState = {
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
    tokenRejectedSince: null,
    tokenRejectedCount: 0,
    lastServerTime: NOW,
    lastServerTimeReceivedAt: NOW,
  };
  return {
    state,
    loopState: 'pushing',
    pendingOperationCount: 1,
    pendingMediaCount: 0,
    rejected: [],
    quarantined: [],
    media: [],
    isOffline: false,
    manualSyncBusy: true,
    manualSyncError: null,
    firstSync: null,
    now: NOW,
  };
}

test('"Terakhir terhubung" ages while no new snapshot arrives', () => {
  vi.useFakeTimers();
  const snapshot = input();
  render(
    <TooltipProvider>
      <SyncStatusButton
        input={snapshot}
        open
        onOpenChange={() => undefined}
        onSyncNow={() => undefined}
        onReenrol={() => undefined}
      />
    </TooltipProvider>,
  );
  const panel = () => screen.getByTestId('desktop.sync.dialog').textContent;
  expect(panel()).toContain('Terakhir terhubung baru saja');
  act(() => {
    vi.advanceTimersByTime(5 * 60_000);
  });
  expect(panel()).toContain('Terakhir terhubung 5 menit lalu');
});
