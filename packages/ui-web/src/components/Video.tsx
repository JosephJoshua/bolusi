// Recording a short clip with the computer's webcam and microphone (the ownership video), and
// playing a stored one back. The recorder shows what the clip must say, a live preview, one button
// to start and stop, and the time taken against the time allowed; it stops by itself at the limit.
// The take plays back to keep or record again. Copy comes from the caller.
import { VIDEO_RECORDING } from '@bolusi/schemas';
import { clsx } from 'clsx';
import { CameraOff, Circle, RefreshCw, Square, SwitchCamera } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Banner } from './Banner.js';
import { Button } from './Button.js';
import { Dialog } from './Dialog.js';
import { IconButton } from './IconButton.js';
import { useWebcam } from './webcam.js';

export interface VideoRecorderLabels {
  readonly close: string;
  readonly start: string;
  readonly stop: string;
  readonly retake: string;
  readonly use: string;
  readonly switchCamera: string;
  readonly retry: string;
  readonly starting: string;
  readonly none: string;
  readonly denied: string;
  readonly failed: string;
  readonly saveFailed: string;
  /** The webcam is there but no microphone: the clip needs the customer's voice. */
  readonly noMicrophone: string;
  /** Longer or sharper than the server takes. */
  readonly tooLarge: string;
  /** "0:07 / 1:00", from the two times. */
  readonly time: (elapsed: string, max: string) => string;
}

const IDEAL = { width: VIDEO_RECORDING.width, height: VIDEO_RECORDING.height };
const RECORDER_TYPES = VIDEO_RECORDING.types;
export type RecordedVideoMime = (typeof RECORDER_TYPES)[number]['mime'];

/** A kept take: the clip and what it is. */
export interface RecordedClip {
  readonly blob: Blob;
  readonly mime: RecordedVideoMime;
}

/** "0:07" for 7 s, as a recorder shows it. */
export function clipTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}

type Take =
  | { readonly kind: 'idle' }
  | { readonly kind: 'recording'; readonly startedAt: number }
  | { readonly kind: 'recorded'; readonly clip: RecordedClip; readonly url: string };

export function VideoRecorderDialog({
  open,
  title,
  hint,
  maxMs,
  maxBytes,
  labels,
  onUse,
  onClose,
  fallback,
  testId = 'video',
}: {
  readonly open: boolean;
  readonly title: string;
  /** What the clip must show, read before recording. */
  readonly hint: string;
  readonly maxMs: number;
  /** The biggest clip the server takes; a bigger take asks for a shorter one. */
  readonly maxBytes: number;
  readonly labels: VideoRecorderLabels;
  /** The kept clip. Resolve when it is stored; a rejection leaves the take to try again. */
  readonly onUse: (clip: RecordedClip) => Promise<void>;
  readonly onClose: () => void;
  /** Shown under the camera's problem. */
  readonly fallback?: React.ReactNode;
  readonly testId?: string;
}): React.JSX.Element {
  const webcam = useWebcam({ open, ideal: IDEAL, audio: true });
  const recorder = useRef<MediaRecorder | null>(null);
  const [take, setTake] = useState<Take>({ kind: 'idle' });
  const [now, setNow] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [tooLarge, setTooLarge] = useState(false);

  // Each opening starts from the live camera; closing drops a recording in progress.
  useEffect(() => {
    if (!open) return;
    setTake({ kind: 'idle' });
    setSaveFailed(false);
    setTooLarge(false);
    return () => {
      const running = recorder.current;
      recorder.current = null;
      if (running !== null && running.state !== 'inactive') running.stop();
    };
  }, [open]);

  useEffect(() => {
    if (take.kind === 'recorded') return () => URL.revokeObjectURL(take.url);
    if (take.kind !== 'recording') return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [take]);

  const start = (): void => {
    const stream = webcam.stream.current;
    if (stream === null) return;
    const format =
      RECORDER_TYPES.find((option) => MediaRecorder.isTypeSupported(option.type)) ??
      RECORDER_TYPES[RECORDER_TYPES.length - 1]!;
    const running = new MediaRecorder(stream, {
      mimeType: format.type,
      videoBitsPerSecond: VIDEO_RECORDING.videoBitsPerSecond,
      audioBitsPerSecond: VIDEO_RECORDING.audioBitsPerSecond,
    });
    const chunks: Blob[] = [];
    running.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    running.addEventListener('stop', () => {
      // Closed mid-way: nothing to keep.
      if (recorder.current !== running) return;
      recorder.current = null;
      const blob = new Blob(chunks, { type: format.mime });
      setTooLarge(blob.size > maxBytes);
      setTake({
        kind: 'recorded',
        clip: { blob, mime: format.mime },
        url: URL.createObjectURL(blob),
      });
    });
    recorder.current = running;
    // In one-second slices, so a stop at the limit loses at most the last moment.
    running.start(1000);
    const startedAt = Date.now();
    setNow(startedAt);
    setTake({ kind: 'recording', startedAt });
  };
  const stop = (): void => {
    if (recorder.current?.state === 'recording') recorder.current.stop();
  };

  // The limit stops it, as the phone's recorder does.
  useEffect(() => {
    if (take.kind !== 'recording') return;
    const timer = setTimeout(stop, Math.max(0, maxMs - (Date.now() - take.startedAt)));
    return () => clearTimeout(timer);
  }, [take, maxMs]);

  const retake = (): void => {
    setSaveFailed(false);
    setTooLarge(false);
    setTake({ kind: 'idle' });
  };
  const use = (): void => {
    if (take.kind !== 'recorded' || tooLarge) return;
    setSaving(true);
    setSaveFailed(false);
    void onUse(take.clip)
      .catch(() => setSaveFailed(true))
      .finally(() => setSaving(false));
  };

  const state = webcam.state;
  const problem = state.kind === 'starting' || state.kind === 'live' ? null : state.kind;

  return (
    <Dialog
      open={open}
      onRequestClose={onClose}
      title={title}
      closeLabel={labels.close}
      size="lg"
      testId={testId}
      banner={
        tooLarge ? (
          <Banner tone="danger" message={labels.tooLarge} />
        ) : saveFailed ? (
          <Banner tone="danger" message={labels.saveFailed} />
        ) : undefined
      }
      footer={
        problem !== null ? undefined : take.kind === 'recorded' ? (
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
              disabled={tooLarge}
              autoFocus
              data-testid={`${testId}.use`}
            />
          </>
        ) : take.kind === 'recording' ? (
          <Button
            label={labels.stop}
            icon={Square}
            variant="danger"
            onClick={stop}
            autoFocus
            data-testid={`${testId}.stop`}
          />
        ) : (
          <>
            {webcam.canSwitch ? (
              <IconButton
                icon={SwitchCamera}
                label={labels.switchCamera}
                onClick={webcam.switchCamera}
                className="mr-auto"
                data-testid={`${testId}.switch`}
              />
            ) : null}
            <Button
              label={labels.start}
              icon={Circle}
              variant="primary"
              onClick={start}
              disabled={state.kind !== 'live'}
              autoFocus
              data-testid={`${testId}.start`}
            />
          </>
        )
      }
    >
      {hint === '' || take.kind === 'recorded' ? null : (
        <p className="mb-3 text-body text-text" data-testid={`${testId}.hint`}>
          {hint}
        </p>
      )}
      <div className="relative mx-auto aspect-video w-[min(100%,calc((min(88vh,820px)-240px)*16/9))] overflow-hidden rounded-sm bg-black">
        <video
          ref={webcam.video}
          muted
          playsInline
          aria-hidden
          className={clsx(
            'size-full object-contain',
            state.kind === 'live' && take.kind !== 'recorded' ? 'block' : 'hidden',
          )}
        />
        {take.kind === 'recorded' ? (
          <video
            src={take.url}
            controls
            autoPlay
            className="size-full object-contain"
            data-testid={`${testId}.take`}
          />
        ) : null}
        {take.kind === 'recording' ? (
          <p
            className="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded-sm bg-black/60 px-3 py-1 text-body-sm tabular-nums text-white"
            data-testid={`${testId}.timer`}
          >
            <span aria-hidden className="size-2 rounded-full bg-danger" />
            {labels.time(clipTime(Math.min(now - take.startedAt, maxMs)), clipTime(maxMs))}
          </p>
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
                onClick={webcam.retry}
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

export type VideoPlayerSource =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly url: string }
  | { readonly kind: 'unavailable' | 'failed' };

/** A stored clip, played in a dialog with the browser's own controls. */
export function VideoPlayerDialog({
  open,
  title,
  source,
  labels,
  onRetry,
  onClose,
  testId = 'videoPlayer',
}: {
  readonly open: boolean;
  readonly title: string;
  readonly source: VideoPlayerSource;
  readonly labels: {
    readonly close: string;
    readonly loading: string;
    readonly retry: string;
    /** Not on this computer yet (still uploading from the phone that took it). */
    readonly unavailable: string;
    readonly failed: string;
  };
  readonly onRetry: () => void;
  readonly onClose: () => void;
  readonly testId?: string;
}): React.JSX.Element {
  return (
    <Dialog
      open={open}
      onRequestClose={onClose}
      title={title}
      closeLabel={labels.close}
      size="lg"
      testId={testId}
      footer={<Button label={labels.close} onClick={onClose} data-testid={`${testId}.close`} />}
    >
      <div className="relative mx-auto aspect-video w-[min(100%,calc((min(88vh,820px)-200px)*16/9))] overflow-hidden rounded-sm bg-black">
        {source.kind === 'ready' ? (
          <video
            src={source.url}
            controls
            autoPlay
            className="size-full object-contain"
            data-testid={`${testId}.video`}
          />
        ) : source.kind === 'loading' ? (
          <p className="absolute inset-0 flex items-center justify-center text-body text-white/80">
            {labels.loading}
          </p>
        ) : (
          <div
            role="alert"
            data-testid={`${testId}.problem`}
            className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-surface-alt px-8 text-center"
          >
            <CameraOff size={32} aria-hidden className="text-text-muted" />
            <p className="max-w-md text-body text-text">{labels[source.kind]}</p>
            <Button
              label={labels.retry}
              icon={RefreshCw}
              onClick={onRetry}
              data-testid={`${testId}.retry`}
            />
          </div>
        )}
      </div>
    </Dialog>
  );
}
