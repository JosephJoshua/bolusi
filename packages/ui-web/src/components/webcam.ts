// The computer's webcam while a dialog is open: the live stream into a preview `<video>`, which
// camera, and what went wrong when it would not start. The photo camera and the video recorder
// share it; the camera runs only while `open`.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/** `noMicrophone`: the camera is there, but the microphone asked for is not. */
export type WebcamProblem = 'none' | 'noMicrophone' | 'denied' | 'failed';

export type WebcamState =
  { readonly kind: 'starting' } | { readonly kind: 'live' } | { readonly kind: WebcamProblem };

export interface Webcam {
  readonly state: WebcamState;
  /** The preview element the stream plays into. */
  readonly video: RefObject<HTMLVideoElement | null>;
  /** The running stream, for a recorder; null until live. */
  readonly stream: RefObject<MediaStream | null>;
  /** More than one camera to choose from. */
  readonly canSwitch: boolean;
  readonly switchCamera: () => void;
  readonly retry: () => void;
}

async function videoInputs(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === 'videoinput');
}

export function useWebcam({
  open,
  ideal,
  audio = false,
}: {
  readonly open: boolean;
  /** The size asked of the camera; it gives what it has, within these. */
  readonly ideal: { readonly width: number; readonly height: number };
  /** The microphone too, for a clip the customer speaks in. */
  readonly audio?: boolean;
}): Webcam {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [state, setState] = useState<WebcamState>({ kind: 'starting' });
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [cameraIndex, setCameraIndex] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const { width, height } = ideal;

  const stop = useCallback(() => {
    for (const track of stream.current?.getTracks() ?? []) track.stop();
    stream.current = null;
  }, []);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setState({ kind: 'starting' });
    void (async () => {
      try {
        const inputs = await videoInputs();
        if (!live) return;
        setCameras(inputs);
        if (inputs.length === 0) {
          setState({ kind: 'none' });
          return;
        }
        const chosen = inputs[cameraIndex % inputs.length];
        const media = await navigator.mediaDevices.getUserMedia({
          audio,
          video: {
            ...(chosen?.deviceId ? { deviceId: { exact: chosen.deviceId } } : {}),
            width: { ideal: width },
            height: { ideal: height },
          },
        });
        if (!live) {
          for (const track of media.getTracks()) track.stop();
          return;
        }
        stream.current = media;
        const preview = video.current;
        if (preview === null) {
          setState({ kind: 'failed' });
          return;
        }
        preview.srcObject = media;
        await preview.play().catch(() => undefined);
        // A shot or a recording needs a frame; a slow USB webcam takes a moment to give the first.
        if (preview.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
          await new Promise((resolve) =>
            preview.addEventListener('loadeddata', resolve, { once: true }),
          );
        }
        if (!live) return;
        // Before the first grant Windows may list the cameras without ids; read them again.
        setCameras(await videoInputs());
        setState({ kind: 'live' });
      } catch (error) {
        if (!live) return;
        const name = error instanceof DOMException ? error.name : '';
        // The cameras were listed, so a device not found with the microphone asked for is that.
        const missing = audio && name === 'NotFoundError' ? 'noMicrophone' : 'none';
        setState({
          kind:
            name === 'NotAllowedError' || name === 'SecurityError'
              ? 'denied'
              : name === 'NotFoundError' || name === 'OverconstrainedError'
                ? missing
                : 'failed',
        });
      }
    })();
    return () => {
      live = false;
      stop();
    };
  }, [open, cameraIndex, attempt, audio, width, height, stop]);

  return {
    state,
    video,
    stream,
    canSwitch: cameras.length > 1,
    switchCamera: useCallback(() => setCameraIndex((n) => n + 1), []),
    retry: useCallback(() => setAttempt((n) => n + 1), []),
  };
}
