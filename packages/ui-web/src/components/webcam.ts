// The computer's webcam while a dialog is open: the live stream into a preview `<video>`, which
// camera, and what went wrong when it would not start. The photo camera and the video recorder
// share it; the camera runs only while `open`. The camera and microphone this computer was set to
// use (`WebcamChoiceProvider`) come first; without one, the first that Windows lists.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';

/** A camera or microphone as this computer lists it. The label finds it again if Windows gives it
 *  a new id (another USB port, a driver update). */
export interface MediaInputChoice {
  readonly deviceId: string;
  readonly label: string;
}

export interface WebcamChoices {
  readonly camera: MediaInputChoice | null;
  readonly microphone: MediaInputChoice | null;
}

const WebcamChoiceContext = createContext<WebcamChoices>({ camera: null, microphone: null });

/** The camera and microphone the app's webcam dialogs use. */
export const WebcamChoiceProvider = WebcamChoiceContext.Provider;

/** The listed input `choice` names: by id, else by label; undefined when it is not plugged in. */
export function findMediaInput<T extends MediaInputChoice>(
  inputs: readonly T[],
  choice: MediaInputChoice | null,
): T | undefined {
  if (choice === null) return undefined;
  return (
    inputs.find((input) => input.deviceId === choice.deviceId) ??
    (choice.label === '' ? undefined : inputs.find((input) => input.label === choice.label))
  );
}

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

async function mediaInputs(kind: MediaDeviceKind): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === kind);
}

const videoInputs = (): Promise<MediaDeviceInfo[]> => mediaInputs('videoinput');

/** The same choice object while its id and label stay, so a re-render does not restart the camera. */
function useSameChoice(choice: MediaInputChoice | null): MediaInputChoice | null {
  const deviceId = choice?.deviceId;
  const label = choice?.label;
  return useMemo(
    () => (deviceId === undefined || label === undefined ? null : { deviceId, label }),
    [deviceId, label],
  );
}

export function useWebcam({
  open,
  ideal,
  audio = false,
  camera,
}: {
  readonly open: boolean;
  /** The size asked of the camera; it gives what it has, within these. */
  readonly ideal: { readonly width: number; readonly height: number };
  /** The microphone too, for a clip the customer speaks in. */
  readonly audio?: boolean;
  /** This camera rather than the one the computer is set to use (Settings' own preview). */
  readonly camera?: MediaInputChoice | null | undefined;
}): Webcam {
  const choices = useContext(WebcamChoiceContext);
  const preferred = useSameChoice(camera === undefined ? choices.camera : camera);
  const microphone = useSameChoice(audio ? choices.microphone : null);
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
        // The chosen camera first; switching moves on from it through the rest.
        const found = findMediaInput(inputs, preferred);
        const first = found === undefined ? 0 : inputs.indexOf(found);
        const chosen = inputs[(first + cameraIndex) % inputs.length];
        const mic = audio ? findMediaInput(await mediaInputs('audioinput'), microphone) : undefined;
        const media = await navigator.mediaDevices.getUserMedia({
          audio: mic?.deviceId ? { deviceId: { exact: mic.deviceId } } : audio,
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
  }, [open, cameraIndex, attempt, audio, width, height, stop, preferred, microphone]);

  return {
    state,
    video,
    stream,
    canSwitch: cameras.length > 1,
    switchCamera: useCallback(() => setCameraIndex((n) => n + 1), []),
    retry: useCallback(() => setAttempt((n) => n + 1), []),
  };
}
