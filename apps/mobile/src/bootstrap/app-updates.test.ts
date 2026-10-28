// A downloaded update runs from the next start, or right as someone comes back from a long break;
// never while the app is in use.
import { describe, expect, test, vi } from 'vitest';

import type { AppStatus } from '@bolusi/device/bootstrap/triggers';

import { BREAK_MS, startAppUpdates, type UpdatesPort } from './app-updates.js';

function harness(options: { enabled?: boolean; pending?: boolean; start?: AppStatus } = {}) {
  let now = 0;
  let status: AppStatus = options.start ?? 'active';
  let listener: ((next: AppStatus) => void) | null = null;
  const state = { pending: options.pending ?? false };
  const updates = {
    isEnabled: options.enabled ?? true,
    pending: () => state.pending,
    downloadNewer: vi.fn(() => Promise.resolve()),
    reload: vi.fn(() => Promise.resolve()),
  } satisfies UpdatesPort;
  const stop = startAppUpdates({
    updates,
    appState: {
      current: () => status,
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
    },
    now: () => now,
  });
  const go = (next: AppStatus, afterMs = 0): void => {
    now += afterMs;
    status = next;
    listener?.(next);
  };
  return { updates, state, go, stop, listening: () => listener !== null };
}

describe('over-the-air updates on a phone', () => {
  test('a short trip out of the app changes nothing', () => {
    const h = harness({ pending: true });
    h.go('background');
    h.go('active', BREAK_MS - 1);
    expect(h.updates.reload).not.toHaveBeenCalled();
    expect(h.updates.downloadNewer).not.toHaveBeenCalled();
  });

  test('back from a long break, a downloaded update restarts the app before anything is touched', () => {
    const h = harness({ pending: true });
    h.go('background');
    h.go('inactive', 1_000);
    h.go('active', BREAK_MS);
    expect(h.updates.reload).toHaveBeenCalledTimes(1);
    expect(h.updates.downloadNewer).not.toHaveBeenCalled();
  });

  test('back from a long break with nothing downloaded, it only checks; the restart waits', async () => {
    const h = harness();
    h.go('background');
    h.go('active', BREAK_MS);
    expect(h.updates.downloadNewer).toHaveBeenCalledTimes(1);
    expect(h.updates.reload).not.toHaveBeenCalled();
    // Downloaded now, but the person is back in the app: it waits for the next break.
    h.state.pending = true;
    await Promise.resolve();
    expect(h.updates.reload).not.toHaveBeenCalled();
    h.go('background');
    h.go('active', BREAK_MS);
    expect(h.updates.reload).toHaveBeenCalledTimes(1);
  });

  test('a failed check is reported and tried again at the next break', async () => {
    const h = harness();
    h.updates.downloadNewer.mockRejectedValueOnce(new Error('offline'));
    h.go('background');
    h.go('active', BREAK_MS);
    await vi.waitFor(() => expect(h.updates.downloadNewer).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    h.go('background');
    h.go('active', BREAK_MS);
    expect(h.updates.downloadNewer).toHaveBeenCalledTimes(2);
  });

  test('a woken background start counts the time until someone opens the app', () => {
    const h = harness({ pending: true, start: 'background' });
    h.go('active', BREAK_MS);
    expect(h.updates.reload).toHaveBeenCalledTimes(1);
  });

  test('development and test builds never look for updates', () => {
    const h = harness({ enabled: false, pending: true });
    expect(h.listening()).toBe(false);
  });
});
