import { initI18n } from '@bolusi/i18n';
import { TooltipProvider } from '@bolusi/ui-web';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { HandoffAsk } from '@bolusi/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HandoffEvent, HandoffOpened } from '../src/core/api.js';
import { createCaptureDialogs, type CaptureDialogs } from '../src/renderer/capture-dialogs.js';
import type { HandoffBridge } from '../src/renderer/phone-handoff.js';

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

/** A webcam and microphone that give a frame at once, and a recorder that hands back its slices. */
function liveCamera(): { asked: MediaStreamConstraints[]; recorders: FakeRecorder[] } {
  const asked: MediaStreamConstraints[] = [];
  const recorders: FakeRecorder[] = [];
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: {
      enumerateDevices: () => Promise.resolve([{ kind: 'videoinput', deviceId: 'cam' }]),
      getUserMedia: (constraints: MediaStreamConstraints) => {
        asked.push(constraints);
        return Promise.resolve({ getTracks: () => [] });
      },
    },
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4);
  class Recorder extends FakeRecorder {
    constructor(_stream: unknown, options: MediaRecorderOptions) {
      super();
      this.options = options;
      recorders.push(this);
    }
  }
  vi.stubGlobal('MediaRecorder', Object.assign(Recorder, { isTypeSupported: () => true }));
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL = (): string => 'blob:clip';
      static override revokeObjectURL = (): void => undefined;
    },
  );
  return { asked, recorders };
}

class FakeRecorder extends EventTarget {
  state: 'inactive' | 'recording' = 'inactive';
  options: MediaRecorderOptions = {};
  start(): void {
    this.state = 'recording';
  }
  stop(): void {
    this.state = 'inactive';
    const data = Object.assign(new Event('dataavailable'), {
      data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])]),
    });
    this.dispatchEvent(data);
    this.dispatchEvent(new Event('stop'));
  }
}

const VIDEO = { title: 'Video kepemilikan', hint: 'Bilang HP ini milikmu.', maxMs: 60_000 };

describe('video recorder', () => {
  it('records with the microphone, then keeps the clip as MP4 once watched back', async () => {
    const camera = liveCamera();
    const dialogs = mount();
    const video = track(dialogs.capture.video(VIDEO));
    expect((await screen.findByTestId('desktop.video.hint')).textContent).toBe(VIDEO.hint);
    const start = await screen.findByTestId('desktop.video.start');
    await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false));
    expect(camera.asked[0]?.audio).toBe(true);
    fireEvent.click(start);
    expect(await screen.findByTestId('desktop.video.timer')).not.toBeNull();
    expect(camera.recorders[0]?.options.videoBitsPerSecond).toBe(2_000_000);
    fireEvent.click(screen.getByTestId('desktop.video.stop'));
    expect(await screen.findByTestId('desktop.video.take')).not.toBeNull();
    expect(video.value).toBe('pending');
    fireEvent.click(screen.getByTestId('desktop.video.use'));
    await waitFor(() =>
      expect(video.value).toEqual({
        bytes: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
        mime: 'video/mp4',
      }),
    );
    expect(screen.queryByTestId('desktop.video')).toBeNull();
  });

  it('stops by itself at the limit', async () => {
    const camera = liveCamera();
    const dialogs = mount();
    void dialogs.capture.video({ ...VIDEO, maxMs: 50 });
    const start = await screen.findByTestId('desktop.video.start');
    await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false));
    fireEvent.click(start);
    expect(await screen.findByTestId('desktop.video.take')).not.toBeNull();
    expect(camera.recorders[0]?.state).toBe('inactive');
  });

  it('closing while recording keeps nothing', async () => {
    liveCamera();
    const dialogs = mount();
    const video = track(dialogs.capture.video(VIDEO));
    const start = await screen.findByTestId('desktop.video.start');
    await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false));
    fireEvent.click(start);
    await screen.findByTestId('desktop.video.stop');
    fireEvent.keyDown(screen.getByTestId('desktop.video'), { key: 'Escape' });
    await waitFor(() => expect(video.value).toBeNull());
  });

  it('says when the camera or microphone is refused', async () => {
    cameras([{ kind: 'videoinput', deviceId: 'cam' }], 'NotAllowedError');
    const dialogs = mount();
    act(() => void dialogs.capture.video(VIDEO));
    const problem = await screen.findByTestId('desktop.video.problem');
    expect(problem.textContent).toContain('mikrofon');
  });
});

describe('video player', () => {
  it('plays the clip and resolves once closed', async () => {
    const dialogs = mount();
    const closed = track(
      dialogs.capture.play({ title: 'Video kepemilikan' }, () =>
        Promise.resolve({ kind: 'ready', url: 'blob:stored' }),
      ),
    );
    expect((await screen.findByTestId('desktop.videoPlayer.video')).getAttribute('src')).toBe(
      'blob:stored',
    );
    fireEvent.click(screen.getByTestId('desktop.videoPlayer.close'));
    await waitFor(() => expect(closed.value).toBeUndefined());
    expect(screen.queryByTestId('desktop.videoPlayer')).toBeNull();
  });

  it('says when the clip is not here yet, and asks again on retry', async () => {
    const dialogs = mount();
    const load = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'unavailable' })
      .mockResolvedValueOnce({ kind: 'ready', url: 'blob:arrived' });
    void dialogs.capture.play({ title: 'Video kepemilikan' }, load);
    expect((await screen.findByTestId('desktop.videoPlayer.problem')).textContent).toContain(
      'belum terkirim',
    );
    fireEvent.click(screen.getByTestId('desktop.videoPlayer.retry'));
    expect(await screen.findByTestId('desktop.videoPlayer.video')).not.toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

function fakeHandoff(opened: HandoffOpened): HandoffBridge & {
  emit: (event: HandoffEvent) => void;
  asks: (HandoffAsk & { seq: number })[];
  withdrawn: number[];
  pairs: number;
  unpaired: string[];
} {
  const listeners = new Set<(event: HandoffEvent) => void>();
  let seq = 0;
  const fake = {
    asks: [] as (HandoffAsk & { seq: number })[],
    withdrawn: [] as number[],
    unpaired: [] as string[],
    pairs: 0,
    available: () => Promise.resolve(true),
    pair: () => {
      fake.pairs += 1;
      return Promise.resolve(opened);
    },
    ask: (_id: string, ask: HandoffAsk) => {
      seq += 1;
      fake.asks.push({ ...ask, seq });
      return Promise.resolve(seq);
    },
    withdraw: (_id: string, n: number) => {
      fake.withdrawn.push(n);
      return Promise.resolve();
    },
    unpair: (id: string) => {
      fake.unpaired.push(id);
      return Promise.resolve();
    },
    onEvent: (listener: (event: HandoffEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event: HandoffEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
  return fake as never;
}

const PHONE_PAGE = 'https://api.bolusi.test/h/abcdefghijklmnopqrstuvwxyz012345';

function track<T>(promise: Promise<T>): { value: T | 'pending' } {
  const box: { value: T | 'pending' } = { value: 'pending' };
  void promise.then((value) => {
    box.value = value;
  });
  return box;
}

describe('phone handoff', () => {
  it('goes straight to a phone when the PC has no webcam, and keeps it paired for the next photo', async () => {
    cameras([]);
    const handoff = fakeHandoff({ ok: true, id: 'h1', urls: [PHONE_PAGE] });
    const dialogs = mount(handoff);
    let front!: { value: unknown };
    await act(async () => {
      front = track(dialogs.capture.photo({ title: 'Depan' }));
      await Promise.resolve();
    });
    // No camera problem first: the QR straight away.
    const qr = await screen.findByTestId('desktop.handoff.qr');
    expect(qr.getAttribute('data-value')).toBe(PHONE_PAGE);
    expect(screen.getByTestId('desktop.handoff.url').textContent).toBe(PHONE_PAGE);
    expect(screen.queryByTestId('desktop.camera')).toBeNull();
    await waitFor(() => expect(handoff.asks).toEqual([{ kind: 'photo', title: 'Depan', seq: 1 }]));

    act(() => handoff.emit({ id: 'h1', type: 'paired' }));
    expect(await screen.findByTestId('desktop.handoff.onPhone')).toBeTruthy();
    expect(screen.queryByTestId('desktop.handoff.qr')).toBeNull();
    // Another pairing's or step's sending is not this one's.
    act(() => handoff.emit({ id: 'other', type: 'photo', seq: 1, bytes: new Uint8Array([1]) }));
    act(() => handoff.emit({ id: 'h1', type: 'photo', seq: 9, bytes: new Uint8Array([1]) }));
    expect(front.value).toBe('pending');
    act(() =>
      handoff.emit({ id: 'h1', type: 'photo', seq: 1, bytes: new Uint8Array([0xff, 0xd8]) }),
    );
    await waitFor(() =>
      expect(front.value).toEqual({ bytes: new Uint8Array([0xff, 0xd8]), mime: 'image/jpeg' }),
    );
    expect(screen.queryByTestId('desktop.handoff')).toBeNull();

    // The next photo goes to the same phone: no new code.
    let back!: { value: unknown };
    await act(async () => {
      back = track(dialogs.capture.photo({ title: 'Belakang' }));
      await Promise.resolve();
    });
    expect(await screen.findByTestId('desktop.handoff.onPhone')).toBeTruthy();
    await waitFor(() =>
      expect(handoff.asks.at(-1)).toEqual({ kind: 'photo', title: 'Belakang', seq: 2 }),
    );
    expect(handoff.pairs).toBe(1);
    // Backing out withdraws the step from the phone but keeps the pairing.
    fireEvent.keyDown(screen.getByTestId('desktop.handoff'), { key: 'Escape' });
    await waitFor(() => expect(back.value).toBeNull());
    expect(handoff.withdrawn).toEqual([2]);
    expect(handoff.unpaired).toEqual([]);
  });

  it('sends the signature to the phone on a PC without touch, or back to the pad', async () => {
    const handoff = fakeHandoff({ ok: true, id: 'h2', urls: [PHONE_PAGE] });
    const dialogs = mount(handoff);
    let signature!: { value: unknown };
    await act(async () => {
      signature = track(dialogs.capture.signature({ title: 'Tanda tangan' }));
      await Promise.resolve();
    });
    await screen.findByTestId('desktop.handoff.qr');
    fireEvent.click(screen.getByTestId('desktop.handoff.back'));
    await screen.findByTestId('desktop.signature.pad');
    await waitFor(() => expect(handoff.withdrawn).toEqual([1]));
    expect(signature.value).toBe('pending');

    fireEvent.click(screen.getByTestId('desktop.usePhone'));
    await screen.findByTestId('desktop.handoff.qr');
    await waitFor(() => expect(handoff.asks.at(-1)?.seq).toBe(2));
    const strokes = [[{ x: 1, y: 2 }]];
    act(() =>
      handoff.emit({
        id: 'h2',
        type: 'signature',
        seq: 2,
        strokes,
        pad: { width: 800, height: 400 },
      }),
    );
    await waitFor(() =>
      expect(signature.value).toEqual({ strokes, pad: { width: 800, height: 400 } }),
    );
  });

  it('offers a new code for another phone, and lets go of the phone when the app closes', async () => {
    cameras([]);
    const handoff = fakeHandoff({ ok: true, id: 'h3', urls: [PHONE_PAGE] });
    const dialogs = mount(handoff);
    act(() => void dialogs.capture.photo({ title: 'Depan' }));
    await screen.findByTestId('desktop.handoff.qr');
    act(() => handoff.emit({ id: 'h3', type: 'paired' }));
    fireEvent.click(await screen.findByTestId('desktop.handoff.newCode'));
    await screen.findByTestId('desktop.handoff.qr');
    expect(handoff.pairs).toBe(2);
    expect(handoff.unpaired).toEqual(['h3']);
    dialogs.unmount();
    expect(handoff.unpaired).toEqual(['h3', 'h3']);
  });

  it('says when the PC is offline, and closing backs out', async () => {
    cameras([]);
    const handoff = fakeHandoff({ ok: false, problem: 'offline' });
    const dialogs = mount(handoff);
    let photo!: { value: unknown };
    await act(async () => {
      photo = track(dialogs.capture.photo({ title: 'Depan' }));
      await Promise.resolve();
    });
    expect((await screen.findByTestId('desktop.handoff.problem')).textContent).toContain(
      'internet',
    );
    fireEvent.keyDown(screen.getByTestId('desktop.handoff'), { key: 'Escape' });
    await waitFor(() => expect(photo.value).toBeNull());
  });

  it('uses the webcam when there is one, with the phone a click away', async () => {
    cameras([{ kind: 'videoinput', deviceId: 'cam' }], 'NotReadableError');
    const handoff = fakeHandoff({ ok: true, id: 'h4', urls: [PHONE_PAGE] });
    const dialogs = mount(handoff);
    await act(async () => {
      void dialogs.capture.photo({ title: 'Depan' });
      await Promise.resolve();
    });
    await screen.findByTestId('desktop.camera.problem');
    expect(screen.getByTestId('desktop.usePhone')).toBeTruthy();
    expect(handoff.pairs).toBe(0);
  });

  it('records the video on the phone when the PC has no webcam, and keeps its clip', async () => {
    cameras([]);
    const handoff = fakeHandoff({ ok: true, id: 'h5', urls: [PHONE_PAGE] });
    const dialogs = mount(handoff);
    let video!: { value: unknown };
    await act(async () => {
      video = track(dialogs.capture.video(VIDEO));
      await Promise.resolve();
    });
    await screen.findByTestId('desktop.handoff.qr');
    expect(screen.queryByTestId('desktop.video')).toBeNull();
    await waitFor(() =>
      expect(handoff.asks).toEqual([
        { kind: 'video', title: VIDEO.title, hint: VIDEO.hint, maxMs: VIDEO.maxMs, seq: 1 },
      ]),
    );
    act(() => handoff.emit({ id: 'h5', type: 'paired' }));
    expect((await screen.findByTestId('desktop.handoff.onPhone')).textContent).toContain(
      'Rekam videonya di HP',
    );
    const clip = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
    act(() => handoff.emit({ id: 'h5', type: 'video', seq: 1, bytes: clip, mime: 'video/webm' }));
    await waitFor(() => expect(video.value).toEqual({ bytes: clip, mime: 'video/webm' }));
    expect(screen.queryByTestId('desktop.handoff')).toBeNull();
  });

  it('backs out of a step on the phone when the counter locks, and offers no missing webcam', async () => {
    cameras([]);
    const handoff = fakeHandoff({ ok: true, id: 'h6', urls: [PHONE_PAGE] });
    const dialogs = mount(handoff);
    let video!: { value: unknown };
    await act(async () => {
      video = track(dialogs.capture.video(VIDEO));
      await Promise.resolve();
    });
    act(() => handoff.emit({ id: 'h6', type: 'paired' }));
    await screen.findByTestId('desktop.handoff.onPhone');
    await waitFor(() => expect(handoff.asks).toHaveLength(1));
    // No webcam to go back to.
    expect(screen.queryByTestId('desktop.handoff.back')).toBeNull();
    // The idle lock: the step is withdrawn, so the phone hears the computer stopped waiting.
    act(() => dialogs.capture.backOut());
    await waitFor(() => expect(video.value).toBeNull());
    expect(handoff.withdrawn).toEqual([1]);
    expect(screen.queryByTestId('desktop.handoff')).toBeNull();
    // A clip sent after that is no one's.
    act(() =>
      handoff.emit({
        id: 'h6',
        type: 'video',
        seq: 1,
        bytes: new Uint8Array([1]),
        mime: 'video/mp4',
      }),
    );
    expect(handoff.unpaired).toEqual([]);
  });

  it('offers the phone when the webcam cannot record', async () => {
    cameras([{ kind: 'videoinput', deviceId: 'cam' }], 'NotReadableError');
    const handoff = fakeHandoff({ ok: true, id: 'h6', urls: [PHONE_PAGE] });
    const dialogs = mount(handoff);
    await act(async () => {
      void dialogs.capture.video(VIDEO);
      await Promise.resolve();
    });
    await screen.findByTestId('desktop.video.problem');
    fireEvent.click(screen.getByTestId('desktop.usePhone'));
    await screen.findByTestId('desktop.handoff.qr');
    await waitFor(() => expect(handoff.asks.at(-1)?.kind).toBe('video'));
  });

  it('offers no phone outside the desktop app', async () => {
    cameras([]);
    const dialogs = mount();
    await act(async () => {
      void dialogs.capture.photo({ title: 'Depan' });
      await Promise.resolve();
    });
    await screen.findByTestId('desktop.camera.problem');
    expect(screen.queryByTestId('desktop.usePhone')).toBeNull();
  });
});

describe('waiting and locking', () => {
  it('says since when a capture is waited for, and backs out of it when told to', async () => {
    const dialogs = mount();
    expect(dialogs.waitingSince()).toBeNull();
    let signature: unknown = 'pending';
    act(() => {
      void dialogs.capture.signature({ title: 'Tanda tangan' }).then((s) => {
        signature = s;
      });
    });
    await screen.findByTestId('desktop.signature');
    expect(dialogs.waitingSince()).toEqual(expect.any(Number));
    act(() => dialogs.cancel());
    await waitFor(() => expect(signature).toBeNull());
    expect(screen.queryByTestId('desktop.signature')).toBeNull();
    expect(dialogs.waitingSince()).toBeNull();
  });
});
