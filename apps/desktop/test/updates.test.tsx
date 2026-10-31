// The counter PC's update rules: quiet checks, a quick retry on flaky internet, and an install only
// when the app closes or nobody is at the counter, after the core has closed its database.
import { Dialog } from '@bolusi/ui-web';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UpdatesBridge, UpdateState } from '../src/main/bridge.js';
import {
  CHECK_EVERY_MS,
  FIRST_CHECK_MS,
  IDLE_INSTALL_SECONDS,
  IDLE_POLL_MS,
  INSTALL_STALL_MS,
  RETRY_AFTER_FAILURE_MS,
  UpdatePolicy,
} from '../src/main/update-policy.js';
import { useReportBusy } from '../src/renderer/updates.js';

interface Harness {
  readonly policy: UpdatePolicy;
  readonly check: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly install: ReturnType<typeof vi.fn<() => void>>;
  readonly stopCore: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly relaunch: ReturnType<typeof vi.fn<() => void>>;
  readonly states: UpdateState[];
  idle: number;
  busy: boolean;
  /** What the next check does. */
  online: boolean;
  readonly order: string[];
}

function harness(): Harness {
  const order: string[] = [];
  const h: Harness = {
    idle: 0,
    busy: false,
    online: true,
    order,
    states: [],
    check: vi.fn(() => (h.online ? Promise.resolve() : Promise.reject(new Error('offline')))),
    install: vi.fn(() => void order.push('install')),
    stopCore: vi.fn(() => {
      order.push('stopCore');
      return Promise.resolve();
    }),
    relaunch: vi.fn(() => void order.push('relaunch')),
    policy: undefined as unknown as UpdatePolicy,
  };
  (h as { policy: UpdatePolicy }).policy = new UpdatePolicy({
    source: { check: h.check, install: h.install },
    idleSeconds: () => h.idle,
    busy: () => h.busy,
    stopCore: h.stopCore,
    relaunch: h.relaunch,
    onState: (state) => h.states.push(state),
  });
  return h;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('checking', () => {
  it('waits out start-up, then checks every few hours', async () => {
    const h = harness();
    h.policy.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS - 1);
    expect(h.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(h.check).toHaveBeenCalledTimes(2);
  });

  it('tries again soon after a failed check instead of waiting hours', async () => {
    const h = harness();
    h.online = false;
    h.policy.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    expect(h.check).toHaveBeenCalledTimes(1);
    h.online = true;
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_FAILURE_MS);
    expect(h.check).toHaveBeenCalledTimes(2);
  });

  it('a download cut off half way goes back to nothing showing and retries soon', async () => {
    const h = harness();
    h.policy.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    h.policy.downloading();
    expect(h.policy.current()).toEqual({ kind: 'downloading' });
    h.policy.failed();
    expect(h.policy.current()).toEqual({ kind: 'none' });
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_FAILURE_MS);
    expect(h.check).toHaveBeenCalledTimes(2);
  });

  it('stops checking once a version is ready', async () => {
    const h = harness();
    h.policy.start();
    h.policy.downloaded('0.2.0');
    h.busy = true;
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 2);
    expect(h.check).not.toHaveBeenCalled();
    expect(h.states).toEqual([{ kind: 'ready', version: '0.2.0' }]);
  });
});

describe('installing', () => {
  it('never installs while someone is using the counter', async () => {
    const h = harness();
    h.policy.downloaded('0.2.0');
    h.idle = 60;
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 30);
    expect(h.install).not.toHaveBeenCalled();
  });

  it('waits for an open dialog or a print even when the PC is idle', async () => {
    const h = harness();
    h.policy.downloaded('0.2.0');
    h.idle = IDLE_INSTALL_SECONDS + 1;
    h.busy = true;
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 5);
    expect(h.install).not.toHaveBeenCalled();
    h.busy = false;
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS);
    expect(h.order).toEqual(['stopCore', 'install']);
  });

  it('closes the core before the installer starts, and installs once', async () => {
    const h = harness();
    h.policy.downloaded('0.2.0');
    await Promise.all([h.policy.install(), h.policy.install()]);
    expect(h.order).toEqual(['stopCore', 'install']);
  });

  it('does nothing when no version is ready', async () => {
    const h = harness();
    await h.policy.install();
    expect(h.stopCore).not.toHaveBeenCalled();
    expect(h.install).not.toHaveBeenCalled();
  });

  it('opens the app again when the installer fails to start', async () => {
    const h = harness();
    h.policy.downloaded('0.2.0');
    await h.policy.install();
    h.policy.failed();
    expect(h.order).toEqual(['stopCore', 'install', 'relaunch']);
  });

  it('opens the app again when the installer never takes over', async () => {
    const h = harness();
    h.policy.downloaded('0.2.0');
    await h.policy.install();
    await vi.advanceTimersByTimeAsync(INSTALL_STALL_MS);
    expect(h.relaunch).toHaveBeenCalledTimes(1);
  });
});

describe('the page reports open dialogs', () => {
  function Probe({ open, updates }: { open: boolean; updates: UpdatesBridge }): React.JSX.Element {
    useReportBusy(updates);
    return (
      <Dialog open={open} onRequestClose={() => undefined} title="Foto" closeLabel="Tutup">
        <p>isi</p>
      </Dialog>
    );
  }

  function fakeUpdates(): UpdatesBridge & {
    busy: ReturnType<typeof vi.fn<UpdatesBridge['busy']>>;
  } {
    return {
      version: () => Promise.resolve('0.1.0'),
      state: () => Promise.resolve({ kind: 'none' }),
      onChange: () => () => undefined,
      install: () => Promise.resolve(),
      busy: vi.fn<UpdatesBridge['busy']>(),
    };
  }

  it('says busy while a dialog is open and quiet once it closes', async () => {
    vi.useRealTimers();
    const updates = fakeUpdates();
    const view = render(<Probe open={false} updates={updates} />);
    expect(updates.busy).not.toHaveBeenCalled();
    view.rerender(<Probe open updates={updates} />);
    await vi.waitFor(() => expect(updates.busy).toHaveBeenLastCalledWith(true));
    view.rerender(<Probe open={false} updates={updates} />);
    await vi.waitFor(() => expect(updates.busy).toHaveBeenLastCalledWith(false));
  });
});
