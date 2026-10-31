import { chromeColor, TooltipProvider } from '@bolusi/ui-web';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WindowBridge } from '../src/main/bridge.js';
import { frameOptions, TITLE_BAR, windowSize } from '../src/main/window-chrome.js';
import { TitleBar } from '../src/renderer/TitleBar.js';

function fakeWindow(fullscreen: boolean): WindowBridge & { emit: (next: boolean) => void } {
  const listeners = new Set<(next: boolean) => void>();
  return {
    fullscreen: vi.fn(() => Promise.resolve(fullscreen)),
    onFullscreenChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (next) => listeners.forEach((listener) => listener(next)),
  };
}

function setWindow(bridge: WindowBridge | undefined): void {
  (globalThis as { bolusi?: unknown }).bolusi =
    bridge === undefined ? undefined : { window: bridge };
}

afterEach(() => {
  cleanup();
  setWindow(undefined);
});

describe('window frame', () => {
  it('lets Windows draw the caption buttons over a bar the colour of the page’s own', () => {
    // The native buttons sit on the page's bar: one colour, or a seam shows between them.
    expect(TITLE_BAR.color).toBe(chromeColor.bar);
    expect(TITLE_BAR.symbolColor).toBe(chromeColor.text);
    expect(frameOptions('win32')).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#0F172A', symbolColor: '#F8FAFC', height: 40 },
    });
    expect(frameOptions('darwin')).toEqual({ titleBarStyle: 'hidden', titleBarOverlay: true });
  });

  it('opens within a small screen and can be made as small as it is', () => {
    expect(windowSize({ width: 1920, height: 1040 })).toEqual({
      width: 1366,
      height: 768,
      minWidth: 1024,
      minHeight: 520,
    });
    // A 1366×768 laptop at 125% scaling, less the taskbar: never held taller than it can show.
    expect(windowSize({ width: 1093, height: 574 })).toEqual({
      width: 1093,
      height: 574,
      minWidth: 1024,
      minHeight: 520,
    });
    expect(windowSize({ width: 1024, height: 560 })).toMatchObject({ height: 560, minHeight: 520 });
  });
});

describe('TitleBar', () => {
  it('names the store in the bar and in the window title, and keeps controls out of the drag area', () => {
    render(
      <TooltipProvider>
        <TitleBar storeName="Toko Sorong Kota">
          <button type="button">Menu akun</button>
        </TitleBar>
      </TooltipProvider>,
    );
    expect(screen.getByTestId('desktop.store').textContent).toBe('Toko Sorong Kota');
    expect(document.title).toBe('Toko Sorong Kota · Bolusi');
    const bar = screen.getByTestId('desktop.titlebar');
    expect(bar.className).toContain('[-webkit-app-region:drag]');
    expect(screen.getByRole('button', { name: 'Menu akun' }).parentElement?.className).toContain(
      '[-webkit-app-region:no-drag]',
    );
  });

  it('shows only Bolusi before the PC belongs to a store', () => {
    render(<TitleBar storeName={null} />);
    expect(screen.queryByTestId('desktop.store')).toBeNull();
    expect(document.title).toBe('Bolusi');
  });

  it('stops dragging and leaving room for the caption buttons in fullscreen', async () => {
    const bridge = fakeWindow(false);
    setWindow(bridge);
    render(
      <TooltipProvider>
        <TitleBar storeName="Toko Sorong Kota" />
      </TooltipProvider>,
    );
    const bar = screen.getByTestId('desktop.titlebar');
    await act(async () => undefined);
    expect(bar.getAttribute('data-fullscreen')).toBeNull();
    act(() => bridge.emit(true));
    expect(bar.getAttribute('data-fullscreen')).toBe('true');
    expect(bar.className).not.toContain('[-webkit-app-region:drag]');
    act(() => bridge.emit(false));
    expect(bar.className).toContain('[-webkit-app-region:drag]');
  });

  it('asks whether the window is already fullscreen when it first draws', async () => {
    setWindow(fakeWindow(true));
    render(<TitleBar />);
    await act(async () => undefined);
    expect(screen.getByTestId('desktop.titlebar').getAttribute('data-fullscreen')).toBe('true');
  });
});
