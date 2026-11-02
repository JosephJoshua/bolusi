// The title bar's sync status reads its age again as time passes, not only when a new snapshot
// arrives: a server that hangs sends none, and "baru saja" must still become "5 menit lalu".
import type { SyncState } from '@bolusi/core';
import type { SyncStatusInput } from '@bolusi/device/models/sync-status/model';
import { initI18n } from '@bolusi/i18n';
import { TooltipProvider } from '@bolusi/ui-web';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
    readSet: null,
    backfill: null,
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
        onMarkRejectedHandled={() => undefined}
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

test('a "Kirim sekarang" that did not get through says so in the panel', () => {
  render(
    <TooltipProvider>
      <SyncStatusButton
        input={{
          ...input(),
          loopState: 'backoff',
          manualSyncBusy: false,
          manualSyncError: 'NETWORK',
        }}
        open
        onOpenChange={() => undefined}
        onSyncNow={() => undefined}
        onReenrol={() => undefined}
        onMarkRejectedHandled={() => undefined}
      />
    </TooltipProvider>,
  );
  expect(screen.getByTestId('desktop.sync.manualError').textContent).toBe(
    'Koneksi bermasalah. Perubahan kamu tetap tersimpan di perangkat ini.',
  );
});

test('the refused changes listed can be marked checked, all of them at once', () => {
  const marked: (readonly string[])[] = [];
  const row = (opId: string) => ({
    opId,
    type: 'repair.ticket_cancelled',
    at: NOW,
    rejectionCode: 'RULE_VIOLATED',
    rejectionReason: null,
    subject: null,
  });
  render(
    <TooltipProvider>
      <SyncStatusButton
        input={{ ...input(), rejected: [row('op-1'), row('op-2')] }}
        open
        onOpenChange={() => undefined}
        onSyncNow={() => undefined}
        onReenrol={() => undefined}
        onMarkRejectedHandled={(opIds) => marked.push(opIds)}
      />
    </TooltipProvider>,
  );
  fireEvent.click(screen.getByTestId('desktop.sync.rejected.handled'));
  expect(marked).toEqual([['op-1', 'op-2']]);
});

test('only what is waiting is counted, and the filled action follows it', () => {
  const panel = (over: Partial<SyncStatusInput>) =>
    render(
      <TooltipProvider>
        <SyncStatusButton
          input={{ ...input(), loopState: 'idle', manualSyncBusy: false, ...over }}
          open
          onOpenChange={() => undefined}
          onSyncNow={() => undefined}
          onReenrol={() => undefined}
          onMarkRejectedHandled={() => undefined}
        />
      </TooltipProvider>,
    );
  panel({ pendingOperationCount: 0 });
  expect(screen.queryByTestId('desktop.sync.waiting.changes')).toBeNull();
  expect(screen.queryByTestId('desktop.sync.waiting.photos')).toBeNull();
  expect(screen.getByTestId('desktop.sync.dialog').textContent).not.toContain('0 belum');
  cleanup();

  panel({ pendingOperationCount: 2 });
  expect(screen.getByTestId('desktop.sync.waiting.changes').textContent).toContain(
    '2 belum tersinkron',
  );
  expect(screen.queryByTestId('desktop.sync.waiting.photos')).toBeNull();
});
