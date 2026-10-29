import { initI18n } from '@bolusi/i18n';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StartupBridge } from '../src/main/bridge.js';
import { StartWithWindows } from '../src/renderer/startup.js';

beforeEach(() => {
  initI18n({ locale: 'id' });
});
afterEach(cleanup);

function fakeStartup(
  open: boolean | null,
  fails = false,
): StartupBridge & { set: ReturnType<typeof vi.fn<StartupBridge['set']>> } {
  return {
    get: () => Promise.resolve(open),
    set: vi.fn<StartupBridge['set']>(() =>
      fails ? Promise.reject(new Error('no')) : Promise.resolve(),
    ),
  };
}

describe('opening with Windows', () => {
  it('turns on from its switch', async () => {
    const startup = fakeStartup(false);
    render(<StartWithWindows startup={startup} />);
    const toggle = await screen.findByTestId('desktop.startup.switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(startup.set).toHaveBeenCalledWith(true);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('shows what Windows will still do when the change fails', async () => {
    const startup = fakeStartup(true, true);
    render(<StartWithWindows startup={startup} />);
    const toggle = await screen.findByTestId('desktop.startup.switch');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
  });

  it('is not offered where the system has no such setting', async () => {
    render(<StartWithWindows startup={fakeStartup(null)} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId('desktop.startup')).toBeNull();
  });
});
