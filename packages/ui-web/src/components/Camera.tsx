// Taking a photo with the computer's webcam: a live preview, one button to shoot, then the shot
// to keep or retake. The camera runs only while the dialog is open. Copy comes from the caller.
import { clsx } from 'clsx';
import { Camera, CameraOff, RefreshCw, SwitchCamera } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

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

type CameraState =
  | { readonly kind: 'starting' }
  | { readonly kind: 'live' }
  | { readonly kind: 'shot'; readonly blob: Blob; readonly url: string }
  | { readonly kind: 'none' | 'denied' | 'failed' };

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
  const stream = useRef<MediaStream | null>(null);
  const [state, setState] = useState<CameraState>({ kind: 'starting' });
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [cameraIndex, setCameraIndex] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

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
          audio: false,
          video: {
            ...(chosen?.deviceId ? { deviceId: { exact: chosen.deviceId } } : {}),
            width: { ideal: IDEAL.width },
            height: { ideal: IDEAL.height },
          },
        });
        if (!live) {
          for (const track of media.getTracks()) track.stop();
          return;
        }
        stream.current = media;
        if (video.current !== null) {
          video.current.srcObject = media;
          await video.current.play().catch(() => undefined);
        }
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
      stop();
    };
  }, [open, cameraIndex, attempt, stop]);

  // A kept or dropped shot frees its preview.
  useEffect(() => {
    if (state.kind !== 'shot') return;
    return () => URL.revokeObjectURL(state.url);
  }, [state]);

  const take = (): void => {
    if (video.current === null) return;
    void shoot(video.current).then((blob) => {
      if (blob !== null) setState({ kind: 'shot', blob, url: URL.createObjectURL(blob) });
    });
  };
  const retake = (): void => {
    setSaveFailed(false);
    setState({ kind: 'live' });
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
          <div
            role="alert"
            data-testid={`${testId}.problem`}
            className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-surface-alt px-8 text-center"
          >
            <CameraOff size={32} aria-hidden className="text-text-muted" />
            <p className="max-w-md text-body text-text">{labels[problem]}</p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Button
                label={labels.retry}
                icon={RefreshCw}
                onClick={() => setAttempt((n) => n + 1)}
                data-testid={`${testId}.retry`}
              />
              {fallback}
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
