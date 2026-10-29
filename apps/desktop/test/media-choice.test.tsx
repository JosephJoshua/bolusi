// The camera and microphone this PC uses: the saved choice is what the check shows and what a
// webcam dialog opens, and picking another one keeps it in the PC's settings.
import { initI18n } from '@bolusi/i18n';
import { CameraDialog, TooltipProvider, type CameraLabels } from '@bolusi/ui-web';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MediaBridge, MediaChoices } from '../src/main/bridge.js';
import { CameraAndMicrophone, MediaChoiceProvider } from '../src/renderer/media-choice.js';

const DEVICES = [
  { kind: 'videoinput', deviceId: 'cam-1', label: 'Integrated Camera' },
  { kind: 'videoinput', deviceId: 'cam-2', label: 'Logitech C270' },
  { kind: 'audioinput', deviceId: 'mic-1', label: 'Microphone Array' },
  { kind: 'audioinput', deviceId: 'mic-2', label: 'Logitech C270 Mic' },
];

let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  initI18n({ locale: 'id' });
  // jsdom plays no video.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  getUserMedia = vi.fn(() => Promise.resolve({ getTracks: () => [] }));
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices: () => Promise.resolve(DEVICES),
      getUserMedia,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'mediaDevices');
});

function fakeMedia(saved: MediaChoices): MediaBridge & {
  choose: ReturnType<typeof vi.fn<MediaBridge['choose']>>;
} {
  return {
    choices: () => Promise.resolve(saved),
    choose: vi.fn<MediaBridge['choose']>(() => Promise.resolve()),
  };
}

/** The camera each `getUserMedia` call asked for. */
const camerasAsked = (): unknown[] =>
  getUserMedia.mock.calls
    .map(([constraints]) => (constraints as { video?: { deviceId?: { exact: string } } }).video)
    .filter((video) => video !== undefined)
    .map((video) => video.deviceId?.exact);

describe('choosing the camera and microphone', () => {
  it('shows the saved camera, and keeps another one when it is picked', async () => {
    const media = fakeMedia({
      camera: { deviceId: 'cam-2', label: 'Logitech C270' },
      microphone: null,
    });
    render(
      <MediaChoiceProvider media={media}>
        <CameraAndMicrophone />
      </MediaChoiceProvider>,
    );
    const cameras = await screen.findByTestId('desktop.media.cameras');
    await waitFor(() =>
      expect(within(cameras).getByRole('radio', { name: 'Logitech C270' }).dataset['state']).toBe(
        'on',
      ),
    );
    await waitFor(() => expect(camerasAsked().at(-1)).toBe('cam-2'));

    fireEvent.click(within(cameras).getByRole('radio', { name: 'Integrated Camera' }));
    expect(media.choose).toHaveBeenCalledWith('camera', {
      deviceId: 'cam-1',
      label: 'Integrated Camera',
    });
    await waitFor(() => expect(camerasAsked().at(-1)).toBe('cam-1'));

    const microphones = screen.getByTestId('desktop.media.microphones');
    fireEvent.click(within(microphones).getByRole('radio', { name: 'Logitech C270 Mic' }));
    expect(media.choose).toHaveBeenCalledWith('microphone', {
      deviceId: 'mic-2',
      label: 'Logitech C270 Mic',
    });
  });

  it('uses the first camera when the saved one is unplugged', async () => {
    render(
      <MediaChoiceProvider
        media={fakeMedia({ camera: { deviceId: 'gone', label: 'Old' }, microphone: null })}
      >
        <CameraAndMicrophone />
      </MediaChoiceProvider>,
    );
    const cameras = await screen.findByTestId('desktop.media.cameras');
    await waitFor(() =>
      expect(
        within(cameras).getByRole('radio', { name: 'Integrated Camera' }).dataset['state'],
      ).toBe('on'),
    );
    await waitFor(() => expect(camerasAsked().at(-1)).toBe('cam-1'));
  });

  it('opens the photo camera on the camera this PC is set to use', async () => {
    const labels = new Proxy({}, { get: (_target, key) => String(key) }) as CameraLabels;
    render(
      <MediaChoiceProvider
        media={fakeMedia({
          camera: { deviceId: 'cam-2', label: 'Logitech C270' },
          microphone: null,
        })}
      >
        <TooltipProvider>
          <CameraDialog open title="Foto" labels={labels} onUse={vi.fn()} onClose={vi.fn()} />
        </TooltipProvider>
      </MediaChoiceProvider>,
    );
    await waitFor(() => expect(camerasAsked().at(-1)).toBe('cam-2'));
  });
});
