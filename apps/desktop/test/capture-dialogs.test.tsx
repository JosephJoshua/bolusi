import { initI18n } from '@bolusi/i18n';
import { TooltipProvider } from '@bolusi/ui-web';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCaptureDialogs, type CaptureDialogs } from '../src/renderer/capture-dialogs.js';

beforeEach(() => {
  initI18n({ locale: 'id' });
  // jsdom lays nothing out: the pad is 400 x 200 on screen, half its own pixels.
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(
    DOMRect.fromRect({ x: 0, y: 0, width: 400, height: 200 }),
  );
  HTMLCanvasElement.prototype.setPointerCapture = () => undefined;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(): CaptureDialogs & { unmount: () => void } {
  const dialogs = createCaptureDialogs();
  const { unmount } = render(
    <TooltipProvider>
      <dialogs.Host />
    </TooltipProvider>,
  );
  return { ...dialogs, unmount };
}

function cameras(devices: readonly Partial<MediaDeviceInfo>[], refuse?: string): void {
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: {
      enumerateDevices: () => Promise.resolve(devices),
      getUserMedia: () =>
        refuse === undefined
          ? Promise.resolve({ getTracks: () => [] })
          : Promise.reject(new DOMException('no', refuse)),
    },
  });
}

describe('signature pad', () => {
  it('hands back the drawn strokes in the pad’s own pixels', async () => {
    const dialogs = mount();
    let signature: unknown;
    act(() => {
      void dialogs.capture.signature({ title: 'Tanda tangan pelanggan' }).then((s) => {
        signature = s;
      });
    });
    const use = await screen.findByTestId('desktop.signature.use');
    expect(use.hasAttribute('disabled')).toBe(true);
    const pad = screen.getByTestId('desktop.signature.pad');
    fireEvent.pointerDown(pad, { pointerId: 1, clientX: 10, clientY: 20 });
    fireEvent.pointerMove(pad, { pointerId: 1, clientX: 100, clientY: 50 });
    fireEvent.pointerUp(pad, { pointerId: 1 });
    // A second pointer moving without pressing draws nothing.
    fireEvent.pointerMove(pad, { pointerId: 2, clientX: 300, clientY: 150 });
    fireEvent.click(screen.getByTestId('desktop.signature.use'));
    await waitFor(() =>
      expect(signature).toEqual({
        strokes: [
          [
            { x: 20, y: 40 },
            { x: 200, y: 100 },
          ],
        ],
        pad: { width: 800, height: 400 },
      }),
    );
    expect(screen.queryByTestId('desktop.signature')).toBeNull();
  });

  it('starts again on clear', async () => {
    const dialogs = mount();
    act(() => void dialogs.capture.signature({ title: 'Tanda tangan' }));
    const pad = await screen.findByTestId('desktop.signature.pad');
    fireEvent.pointerDown(pad, { pointerId: 1, clientX: 10, clientY: 20 });
    fireEvent.pointerUp(pad, { pointerId: 1 });
    fireEvent.click(screen.getByTestId('desktop.signature.clear'));
    expect(screen.getByTestId('desktop.signature.use').hasAttribute('disabled')).toBe(true);
  });
});

describe('webcam', () => {
  it('says so when the PC has no webcam, and backing out takes nothing', async () => {
    cameras([]);
    const dialogs = mount();
    let photo: unknown = 'pending';
    act(() => {
      void dialogs.capture.photo({ title: 'Depan' }).then((p) => {
        photo = p;
      });
    });
    expect((await screen.findByTestId('desktop.camera.problem')).textContent).toContain(
      'Kamera tidak ditemukan',
    );
    fireEvent.keyDown(screen.getByTestId('desktop.camera'), { key: 'Escape' });
    await waitFor(() => expect(photo).toBeNull());
  });

  it('tells a refused camera apart from a missing one', async () => {
    cameras([{ kind: 'videoinput', deviceId: 'cam' }], 'NotAllowedError');
    const dialogs = mount();
    act(() => void dialogs.capture.photo({ title: 'Depan' }));
    const problem = await screen.findByTestId('desktop.camera.problem');
    expect(problem.textContent).toContain('belum diizinkan');
    expect(screen.queryByTestId('desktop.camera.shoot')).toBeNull();
  });

  it('cancels the open capture when another is asked for, or the app closes', async () => {
    cameras([]);
    const dialogs = mount();
    const first = dialogs.capture.photo({ title: 'Depan' });
    let second: unknown = 'pending';
    act(() => {
      void dialogs.capture.signature({ title: 'Tanda tangan' }).then((s) => {
        second = s;
      });
    });
    await expect(first).resolves.toBeNull();
    await screen.findByTestId('desktop.signature');
    dialogs.unmount();
    await waitFor(() => expect(second).toBeNull());
  });
});
