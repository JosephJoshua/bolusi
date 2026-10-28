// Taking a photo with the computer's webcam: a live preview, one button to shoot, then the shot
// to keep or retake. The camera runs only while the dialog is open. Copy comes from the caller.
import { clsx } from 'clsx';
import { Camera, CameraOff, RefreshCw, SwitchCamera } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Banner } from './Banner.js';
import { Button } from './Button.js';
import { Dialog } from './Dialog.js';
import { IconButton } from './IconButton.js';

export interface CameraLabels {
  readonly close: string;
  readonly shoot: string;
  readonly retake: string;
  readonly use: string;
  readonly switchCamera: string;
  readonly retry: string;
  readonly starting: string;
  /** No webcam on this computer. */
  readonly none: string;
  /** Windows or the person refused the camera. */
  readonly denied: string;
  /** The camera is there but would not start (in use by another app, unplugged mid-way). */
  readonly failed: string;
  /** Keeping the photo failed (storage); the shot stays to try again. */
  readonly saveFailed: string;
}

type Shot = { readonly blob: Blob; readonly url: string };
type CameraState = WebcamState | ({ readonly kind: 'shot' } & Shot);

// Webcams give 720p or 1080p; the photo is taken at what the camera gives, within these.
const IDEAL = { width: 1600, height: 1200 };
export const CAMERA_JPEG_QUALITY = 0.7;

async function videoInputs(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === 'videoinput');
}

function shoot(video: HTMLVideoElement): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext('2d');
  if (context === null || canvas.width === 0) return Promise.resolve(null);
  context.drawImage(video, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', CAMERA_JPEG_QUALITY));
}

/** The webcam's stream on a `<video>`: starting, live, or why there is no picture. */
export type WebcamState =
  { readonly kind: 'starting' | 'live' } | { readonly kind: 'none' | 'denied' | 'failed' };

/**
 * Runs the webcam on `video` while `active`: the chosen camera of those connected (`cameraIndex`
 * wraps around), started again when `attempt` changes. Stops the camera when inactive or unmounted.
 */
export function useWebcam(
  video: React.RefObject<HTMLVideoElement | null>,
  active: boolean,
  cameraIndex: number,
  attempt: number,
): { readonly state: WebcamState; readonly cameras: readonly MediaDeviceInfo[] } {
  const [state, setState] = useState<WebcamState>({ kind: 'starting' });
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    if (!active) return;
    let live = true;
    let media: MediaStream | null = null;
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
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            ...(chosen?.deviceId ? { deviceId: { exact: chosen.deviceId } } : {}),
            width: { ideal: IDEAL.width },
            height: { ideal: IDEAL.height },
          },
        });
        media = stream;
        if (!live) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        const preview = video.current;
        if (preview === null) {
          setState({ kind: 'failed' });
          return;
        }
        preview.srcObject = stream;
        await preview.play().catch(() => undefined);
        // Shooting needs a frame; a slow USB webcam takes a moment to give the first one.
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
        setState({
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
      for (const track of media?.getTracks() ?? []) track.stop();
    };
  }, [video, active, cameraIndex, attempt]);
  return { state, cameras };
}

export function CameraDialog({
  open,
  title,
  labels,
  onUse,
  onClose,
  /** Shown under the camera's problem, such as "Pakai HP" to take it on a phone instead. */
  fallback,
  testId = 'camera',
}: {
  readonly open: boolean;
  readonly title: string;
  readonly labels: CameraLabels;
  /** The kept photo, as a JPEG. Resolve when it is stored; a rejection leaves the shot to retry. */
  readonly onUse: (photo: Blob) => Promise<void>;
  readonly onClose: () => void;
  readonly fallback?: React.ReactNode;
  readonly testId?: string;
}): React.JSX.Element {
  const video = useRef<HTMLVideoElement>(null);
  const [cameraIndex, setCameraIndex] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const webcam = useWebcam(video, open, cameraIndex, attempt);
  const cameras = webcam.cameras;
  const [shot, setShot] = useState<Shot | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  // Each opening starts on the live picture.
  useEffect(() => {
    if (!open) return;
    setShot(null);
    setSaveFailed(false);
  }, [open, cameraIndex, attempt]);
  const state: CameraState = shot !== null ? { kind: 'shot', ...shot } : webcam.state;

  // A kept or dropped shot frees its preview.
  useEffect(() => {
    if (shot === null) return;
    return () => URL.revokeObjectURL(shot.url);
  }, [shot]);

  const take = (): void => {
    if (video.current === null) return;
    void shoot(video.current).then((blob) => {
      if (blob !== null) setShot({ blob, url: URL.createObjectURL(blob) });
    });
  };
  const retake = (): void => {
    setSaveFailed(false);
    setShot(null);
  };
  const use = (): void => {
    if (state.kind !== 'shot') return;
    setSaving(true);
    setSaveFailed(false);
    void onUse(state.blob)
      .catch(() => setSaveFailed(true))
      .finally(() => setSaving(false));
  };

  const problem =
    state.kind === 'none' || state.kind === 'denied' || state.kind === 'failed' ? state.kind : null;

  return (
    <Dialog
      open={open}
      onRequestClose={onClose}
      title={title}
      closeLabel={labels.close}
      size="lg"
      testId={testId}
      banner={saveFailed ? <Banner tone="danger" message={labels.saveFailed} /> : undefined}
      footer={
        problem !== null ? undefined : state.kind === 'shot' ? (
          <>
            <Button
              label={labels.retake}
              onClick={retake}
              disabled={saving}
              data-testid={`${testId}.retake`}
            />
            <Button
              label={labels.use}
              variant="primary"
              onClick={use}
              busy={saving}
              autoFocus
              data-testid={`${testId}.use`}
            />
          </>
        ) : (
          <>
            {cameras.length > 1 ? (
              <IconButton
                icon={SwitchCamera}
                label={labels.switchCamera}
                onClick={() => setCameraIndex((n) => n + 1)}
                className="mr-auto"
                data-testid={`${testId}.switch`}
              />
            ) : null}
            <Button
              label={labels.shoot}
              icon={Camera}
              variant="primary"
              onClick={take}
              disabled={state.kind !== 'live'}
              autoFocus
              data-testid={`${testId}.shoot`}
            />
          </>
        )
      }
    >
      {/* As wide as fits without scrolling: the dialog's height less its header and footer. */}
      <div className="relative mx-auto aspect-[4/3] w-[min(100%,calc((min(88vh,820px)-200px)*4/3))] overflow-hidden rounded-sm bg-black">
        <video
          ref={video}
          muted
          playsInline
          aria-hidden
          className={clsx('size-full object-contain', state.kind === 'live' ? 'block' : 'hidden')}
        />
        {state.kind === 'shot' ? (
          <img
            src={state.url}
            alt={title}
            className="size-full object-contain"
            data-testid={`${testId}.shot`}
          />
        ) : null}
        {state.kind === 'starting' ? (
          <p className="absolute inset-0 flex items-center justify-center text-body text-white/80">
            {labels.starting}
          </p>
        ) : null}
        {problem !== null ? (
          <CameraProblem
            message={labels[problem]}
            retryLabel={labels.retry}
            onRetry={() => setAttempt((n) => n + 1)}
            testId={testId}
          >
            {fallback}
          </CameraProblem>
        ) : null}
      </div>
    </Dialog>
  );
}

/** Why there is no picture, over the camera's frame, with a retry and the caller's way around it. */
function CameraProblem({
  message,
  retryLabel,
  onRetry,
  testId,
  children,
}: {
  readonly message: string;
  readonly retryLabel: string;
  readonly onRetry: () => void;
  readonly testId: string;
  readonly children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      role="alert"
      data-testid={`${testId}.problem`}
      className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-surface-alt px-8 text-center"
    >
      <CameraOff size={32} aria-hidden className="text-text-muted" />
      <p className="max-w-md text-body text-text">{message}</p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button
          label={retryLabel}
          icon={RefreshCw}
          onClick={onRetry}
          data-testid={`${testId}.retry`}
        />
        {children}
      </div>
    </div>
  );
}

/**
 * The webcam's live picture on a page, to check it works: no shooting. Reports what it found, so
 * the page can say whether photos will come from here or from a phone.
 */
export function CameraPreview({
  labels,
  onState,
  testId = 'camera.preview',
}: {
  readonly labels: Pick<CameraLabels, 'retry' | 'starting' | 'none' | 'denied' | 'failed'>;
  readonly onState?: ((state: WebcamState['kind']) => void) | undefined;
  readonly testId?: string;
}): React.JSX.Element {
  const video = useRef<HTMLVideoElement>(null);
  const [attempt, setAttempt] = useState(0);
  const { state } = useWebcam(video, true, 0, attempt);
  const latest = useRef(onState);
  latest.current = onState;
  useEffect(() => latest.current?.(state.kind), [state.kind]);
  const problem =
    state.kind === 'none' || state.kind === 'denied' || state.kind === 'failed' ? state.kind : null;
  return (
    <div
      className="relative aspect-[4/3] w-full max-w-md overflow-hidden rounded-sm bg-black"
      data-testid={testId}
      data-state={state.kind}
    >
      <video
        ref={video}
        muted
        playsInline
        aria-hidden
        className={clsx('size-full object-contain', state.kind === 'live' ? 'block' : 'hidden')}
      />
      {state.kind === 'starting' ? (
        <p className="absolute inset-0 flex items-center justify-center text-body text-white/80">
          {labels.starting}
        </p>
      ) : null}
      {problem !== null ? (
        <CameraProblem
          message={labels[problem]}
          retryLabel={labels.retry}
          onRetry={() => setAttempt((n) => n + 1)}
          testId={testId}
        />
      ) : null}
    </div>
  );
}
