// The cameras and microphones this computer lists, kept current as they are plugged in and out,
// and how loud the chosen microphone hears the room (to show it works before a video needs it).
import { useEffect, useState } from 'react';

import { findMediaInput, type MediaInputChoice } from './webcam.js';

export interface MediaInputs {
  /** Null until the first read. */
  readonly cameras: readonly MediaInputChoice[] | null;
  readonly microphones: readonly MediaInputChoice[] | null;
}

function choicesOf(devices: readonly MediaDeviceInfo[], kind: MediaDeviceKind): MediaInputChoice[] {
  return devices
    .filter((device) => device.kind === kind && device.deviceId !== '')
    .map((device) => ({ deviceId: device.deviceId, label: device.label }));
}

/**
 * The inputs, read again when Windows reports a change and whenever `refresh` changes: before the
 * first camera grant the list has no names, so a caller passes the preview's state to re-read.
 */
export function useMediaInputs(refresh?: unknown): MediaInputs {
  const [inputs, setInputs] = useState<MediaInputs>({ cameras: null, microphones: null });
  useEffect(() => {
    const media = navigator.mediaDevices as MediaDevices | undefined;
    if (media === undefined) {
      setInputs({ cameras: [], microphones: [] });
      return;
    }
    let live = true;
    const read = (): void => {
      media.enumerateDevices().then(
        (devices) => {
          if (live) {
            setInputs({
              cameras: choicesOf(devices, 'videoinput'),
              microphones: choicesOf(devices, 'audioinput'),
            });
          }
        },
        () => {
          if (live) setInputs({ cameras: [], microphones: [] });
        },
      );
    };
    read();
    media.addEventListener('devicechange', read);
    return () => {
      live = false;
      media.removeEventListener('devicechange', read);
    };
  }, [refresh]);
  return inputs;
}

/** What the microphone check shows: its level from 0 to 1 while it listens, or why it cannot. */
export type MicrophoneLevel =
  | { readonly kind: 'starting' }
  | { readonly kind: 'live'; readonly level: number }
  | { readonly kind: 'none' | 'denied' | 'failed' };

/** Listens to `choice` (else the first microphone) while mounted, and reports how loud it is. */
export function useMicrophoneLevel(choice: MediaInputChoice | null): MicrophoneLevel {
  const [level, setLevel] = useState<MicrophoneLevel>({ kind: 'starting' });
  const deviceId = choice?.deviceId;
  const label = choice?.label;
  useEffect(() => {
    let live = true;
    let frame = 0;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    setLevel({ kind: 'starting' });
    void (async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const microphones = devices.filter((device) => device.kind === 'audioinput');
        if (microphones.length === 0) {
          if (live) setLevel({ kind: 'none' });
          return;
        }
        const wanted = deviceId === undefined || label === undefined ? null : { deviceId, label };
        const found = findMediaInput(microphones, wanted);
        stream = await navigator.mediaDevices.getUserMedia({
          audio: found?.deviceId ? { deviceId: { exact: found.deviceId } } : true,
        });
        if (!live) return;
        context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        context.createMediaStreamSource(stream).connect(analyser);
        const samples = new Uint8Array(analyser.fftSize);
        let shown = -1;
        const tick = (): void => {
          analyser.getByteTimeDomainData(samples);
          let peak = 0;
          for (const sample of samples) peak = Math.max(peak, Math.abs(sample - 128));
          // Speech peaks well under full scale; this makes a normal voice fill most of the bar. In
          // twentieths, so a slow PC re-renders only when the bar visibly moves.
          const step = Math.round(Math.min(1, (peak / 128) * 2.5) * 20);
          if (step !== shown) {
            shown = step;
            setLevel({ kind: 'live', level: step / 20 });
          }
          frame = requestAnimationFrame(tick);
        };
        tick();
      } catch (error) {
        if (!live) return;
        const name = error instanceof DOMException ? error.name : '';
        setLevel({
          kind:
            name === 'NotAllowedError' || name === 'SecurityError'
              ? 'denied'
              : name === 'NotFoundError' || name === 'OverconstrainedError'
                ? 'none'
                : 'failed',
        });
      }
    })();
    return () => {
      live = false;
      cancelAnimationFrame(frame);
      for (const track of stream?.getTracks() ?? []) track.stop();
      void context?.close();
    };
  }, [deviceId, label]);
  return level;
}
