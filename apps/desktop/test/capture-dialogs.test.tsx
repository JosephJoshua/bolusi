import { initI18n } from '@bolusi/i18n';
import { TooltipProvider } from '@bolusi/ui-web';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HandoffBridge, HandoffEvent, HandoffOpened } from '../src/main/bridge.js';
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

function mount(handoff?: HandoffBridge): CaptureDialogs & { unmount: () => void } {
  const dialogs = createCaptureDialogs(handoff);
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

function fakeHandoff(opened: HandoffOpened): HandoffBridge & {
  emit: (event: HandoffEvent) => void;
  cancelled: string[];
  kinds: string[];
} {
  const listeners = new Set<(event: HandoffEvent) => void>();
  const cancelled: string[] = [];
  const kinds: string[] = [];
  return {
    open: (kind) => {
      kinds.push(kind);
      return Promise.resolve(opened);
    },
    cancel: (id) => {
      cancelled.push(id);
      return Promise.resolve();
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    cancelled,
    kinds,
  };
}

const URL_ON_LAN = `http://192.168.1.23:51234/h/${'k'.repeat(32)}`;

describe('phone handoff', () => {
  it('hands a photo to a phone when the PC has no webcam', async () => {
    cameras([]);
    const handoff = fakeHandoff({ ok: true, id: 'h1', urls: [URL_ON_LAN] });
    const dialogs = mount(handoff);
    let photo: unknown = 'pending';
    act(() => {
      void dialogs.capture.photo({ title: 'Depan' }).then((p) => {
        photo = p;
      });
    });
    await screen.findByTestId('desktop.camera.problem');
    fireEvent.click(screen.getByTestId('desktop.usePhone'));
    const qr = await screen.findByTestId('desktop.handoff.qr');
    expect(qr.getAttribute('data-value')).toBe(URL_ON_LAN);
    expect(screen.getByTestId('desktop.handoff.url').textContent).toBe(URL_ON_LAN);
    expect(screen.queryByTestId('desktop.camera')).toBeNull();
    expect(handoff.kinds).toEqual(['photo']);

    act(() => handoff.emit({ id: 'h1', type: 'opened' }));
    expect(screen.getByTestId('desktop.handoff.status').textContent).toContain('tersambung');
    // Another capture's event is not this one's.
    act(() => handoff.emit({ id: 'other', type: 'photo', bytes: new Uint8Array([1]) }));
    expect(photo).toBe('pending');
    act(() => handoff.emit({ id: 'h1', type: 'photo', bytes: new Uint8Array([0xff, 0xd8]) }));
    await waitFor(() =>
      expect(photo).toEqual({ bytes: new Uint8Array([0xff, 0xd8]), mime: 'image/jpeg' }),
    );
    expect(screen.queryByTestId('desktop.handoff')).toBeNull();
    // Done: nothing left to cancel.
    expect(handoff.cancelled).toEqual([]);
  });

  it('takes the signature on a phone, or goes back to the pad', async () => {
    const handoff = fakeHandoff({ ok: true, id: 'h2', urls: [URL_ON_LAN] });
    const dialogs = mount(handoff);
    let signature: unknown = 'pending';
    act(() => {
      void dialogs.capture.signature({ title: 'Tanda tangan' }).then((s) => {
        signature = s;
      });
    });
    fireEvent.click(await screen.findByTestId('desktop.usePhone'));
    await screen.findByTestId('desktop.handoff.qr');
    fireEvent.click(screen.getByTestId('desktop.handoff.back'));
    await screen.findByTestId('desktop.signature.pad');
    // Leaving the phone page cancels its code; the capture itself is still open.
    expect(handoff.cancelled).toEqual(['h2']);
    expect(signature).toBe('pending');

    fireEvent.click(screen.getByTestId('desktop.usePhone'));
    await screen.findByTestId('desktop.handoff.qr');
    const strokes = [[{ x: 1, y: 2 }]];
    act(() =>
      handoff.emit({ id: 'h2', type: 'signature', strokes, pad: { width: 800, height: 400 } }),
    );
    await waitFor(() => expect(signature).toEqual({ strokes, pad: { width: 800, height: 400 } }));
  });

  it('says when the PC is on no network, and closing backs out', async () => {
    cameras([]);
    const handoff = fakeHandoff({ ok: false, problem: 'noNetwork' });
    const dialogs = mount(handoff);
    const photo = dialogs.capture.photo({ title: 'Depan' });
    fireEvent.click(await screen.findByTestId('desktop.usePhone'));
    expect((await screen.findByTestId('desktop.handoff.problem')).textContent).toContain('Wi-Fi');
    fireEvent.keyDown(screen.getByTestId('desktop.handoff'), { key: 'Escape' });
    await expect(photo).resolves.toBeNull();
  });

  it('offers no phone outside the desktop app', async () => {
    cameras([]);
    const dialogs = mount();
    act(() => void dialogs.capture.photo({ title: 'Depan' }));
    await screen.findByTestId('desktop.camera.problem');
    expect(screen.queryByTestId('desktop.usePhone')).toBeNull();
  });
});
