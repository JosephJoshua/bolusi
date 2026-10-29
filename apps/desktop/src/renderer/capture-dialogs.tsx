// The counter PC's webcam dialog, signature pad and video recorder and player, mounted once in the
// app. `capture` answers the screens' photo, signature and video asks like the phone's camera, pad
// and recorder do: a JPEG from the webcam, the drawn strokes, or the recorded clip, and null when
// the person backs out. A PC without a webcam, or without a touch
// screen for signing, hands the step to a paired store phone instead (`phone-handoff.tsx`), which
// answers the same way; one scan covers every step after it. Storing and signing what was taken
// is the runtime's job.
import { t } from '@bolusi/i18n';
import {
  Button,
  CameraDialog,
  SignatureDialog,
  VideoPlayerDialog,
  VideoRecorderDialog,
  type DrawnSignature,
  type RecordedClip,
  type VideoPlayerSource,
} from '@bolusi/ui-web';
import { VIDEO_MAX_SIZE_BYTES } from '@bolusi/schemas';
import { FileImage, Smartphone } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';

import {
  pickPhotoFile,
  type PcCapture,
  type PcPhoto,
  type PcVideo,
  type PcVideoRequest,
  type PcVideoSource,
} from './capture.js';
import {
  PhoneHandoffDialog,
  PhoneLinkStore,
  type HandoffBridge,
  type HandoffResult,
} from './phone-handoff.js';

type Pending = (
  | {
      readonly kind: 'photo';
      readonly resolve: (photo: PcPhoto | null) => void;
    }
  | {
      readonly kind: 'signature';
      readonly resolve: (signature: DrawnSignature | null) => void;
    }
  | {
      // The phone handoff takes photos and signatures only, so a clip is always the webcam's.
      readonly kind: 'video';
      readonly request: PcVideoRequest;
      readonly resolve: (video: PcVideo | null) => void;
    }
) & {
  readonly title: string;
  /** This PC's webcam or pad, or the paired phone. */
  readonly via: 'pc' | 'phone';
};

export interface CaptureDialogs {
  readonly capture: PcCapture;
  /** Mount once, inside the app, to show the dialogs. */
  readonly Host: () => React.JSX.Element;
  /** Since when a photo, signature or video has been waited for; null when none is. */
  readonly waitingSince: () => number | null;
  /** Backs out of whatever is open (the screen locked): nothing floats over the lock. */
  readonly cancel: () => void;
}

/** Whether Windows lists a webcam; false when it cannot be asked. */
export async function hasWebcam(): Promise<boolean> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.some((device) => device.kind === 'videoinput');
  } catch {
    return false;
  }
}

/** A finger or pen to sign with; a mouse alone makes a poor signature. */
export const hasTouch = (): boolean =>
  typeof window.matchMedia === 'function' && window.matchMedia('(any-pointer: coarse)').matches;

/** `handoff` is the desktop app's phone handoff; without it (a plain browser) there is none. */
export function createCaptureDialogs(handoff?: HandoffBridge): CaptureDialogs {
  const phone = handoff === undefined ? null : new PhoneLinkStore(handoff);
  const phoneAvailable = handoff?.available().catch(() => false) ?? Promise.resolve(false);
  /** Offer the phone only once there is a server to pair through. */
  let offerPhone = false;
  let pending: Pending | null = null;
  let pendingSince: number | null = null;
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of listeners) listener();
  };
  void phoneAvailable.then((available) => {
    offerPhone = available;
    emit();
  });
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  /** Ends the open capture with `value`, and closes its dialog. */
  const settle = (value: PcPhoto | DrawnSignature | PcVideo | null): void => {
    const current = pending;
    if (current === null) return;
    pending = null;
    pendingSince = null;
    phone?.withdraw();
    (current.resolve as (value: PcPhoto | DrawnSignature | PcVideo | null) => void)(value);
    emit();
  };
  const close = (): void => settle(null);

  /** The clip being watched: one at a time, closed by the person. */
  let playing: {
    readonly title: string;
    readonly source: VideoPlayerSource;
    readonly load: () => Promise<PcVideoSource>;
    readonly done: () => void;
  } | null = null;
  const loadPlaying = (current: NonNullable<typeof playing>): void => {
    playing = { ...current, source: { kind: 'loading' } };
    emit();
    const asked = playing;
    void current.load().then(
      (source) => {
        if (playing !== asked) {
          // Closed or replaced while it loaded: the clip's url goes with it.
          if (source.kind === 'ready') URL.revokeObjectURL(source.url);
          return;
        }
        playing = { ...asked, source };
        emit();
      },
      () => {
        if (playing !== asked) return;
        playing = { ...asked, source: { kind: 'failed' } };
        emit();
      },
    );
  };
  const closePlayer = (): void => {
    const current = playing;
    if (current === null) return;
    playing = null;
    if (current.source.kind === 'ready') URL.revokeObjectURL(current.source.url);
    current.done();
    emit();
  };

  /** Hands the open capture to the phone; what it sends ends the capture. */
  const onPhone = (current: Pending): void => {
    if (phone === null || current.kind === 'video') return;
    void phone.take(current.kind, current.title).then((result: HandoffResult | null) => {
      if (pending !== current || result === null) return;
      settle(
        result.kind === 'photo' ? { bytes: result.bytes, mime: 'image/jpeg' } : result.signature,
      );
    });
  };

  const start = (next: Pending): void => {
    // One capture at a time: a second ask while one is open cancels the first.
    settle(null);
    pending = next;
    pendingSince = Date.now();
    emit();
    if (next.via === 'phone') onPhone(next);
  };
  const switchTo = (via: Pending['via']): void => {
    if (pending === null || pending.via === via) return;
    phone?.withdraw();
    pending = { ...pending, via };
    emit();
    if (via === 'phone') onPhone(pending);
  };

  /** Straight to the phone when it is already paired, or when this PC cannot do the step. */
  const startVia = async (kind: Pending['kind']): Promise<Pending['via']> => {
    if (phone === null || !(await phoneAvailable)) return 'pc';
    if (phone.paired) return 'phone';
    return (kind === 'photo' ? await hasWebcam() : hasTouch()) ? 'pc' : 'phone';
  };

  const keepPhoto = async (blob: Blob): Promise<void> => {
    const current = pending;
    if (current?.kind !== 'photo') return;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (pending === current) settle({ bytes, mime: 'image/jpeg' });
  };
  const keepPicture = (photo: PcPhoto | null): void => {
    if (pending?.kind === 'photo' && photo !== null) settle(photo);
  };
  const keepVideo = async (clip: RecordedClip): Promise<void> => {
    const current = pending;
    if (current?.kind !== 'video') return;
    const bytes = new Uint8Array(await clip.blob.arrayBuffer());
    if (pending === current) settle({ bytes, mime: clip.mime });
  };
  const keepSignature = (signature: DrawnSignature): Promise<void> => {
    if (pending?.kind === 'signature') settle(signature);
    return Promise.resolve();
  };

  const usePhone = (): React.JSX.Element | null =>
    !offerPhone ? null : (
      <Button
        label={t('core.handoff.usePhone')}
        icon={Smartphone}
        variant="text"
        onClick={() => switchTo('phone')}
        data-testid="desktop.usePhone"
      />
    );
  // No webcam, or Windows refused it: a store phone, or a photo saved on this PC.
  const photoFallback = (): React.JSX.Element => (
    <>
      {usePhone()}
      <Button
        label={t('core.camera.fromFile')}
        icon={FileImage}
        variant="text"
        onClick={() => void pickPhotoFile().then(keepPicture, () => undefined)}
        data-testid="desktop.camera.file"
      />
    </>
  );

  const noLink = { state: 'none' } as const;
  const noSubscribe = (): (() => void) => () => undefined;

  function Host(): React.JSX.Element {
    const current = useSyncExternalStore(subscribe, () => pending);
    const watching = useSyncExternalStore(subscribe, () => playing);
    // Re-render when the phone becomes available.
    useSyncExternalStore(subscribe, () => offerPhone);
    const link = useSyncExternalStore(phone?.subscribe ?? noSubscribe, () =>
      phone === null ? noLink : phone.snapshot(),
    );
    // A capture still open when the app goes away is backed out of, and the phone let go.
    useEffect(
      () => () => {
        close();
        closePlayer();
        phone?.close();
      },
      [],
    );
    return (
      <>
        <PhoneHandoffDialog
          open={current?.via === 'phone'}
          link={link}
          kind={current?.kind === 'signature' ? 'signature' : 'photo'}
          title={current?.title ?? ''}
          backLabel={t(
            current?.kind === 'signature' ? 'core.handoff.useScreen' : 'core.handoff.useWebcam',
          )}
          onBack={() => switchTo('pc')}
          onNewCode={() => phone?.repair()}
          onClose={close}
        />
        <CameraDialog
          open={current?.via === 'pc' && current.kind === 'photo'}
          fallback={photoFallback()}
          title={current?.title ?? ''}
          onUse={keepPhoto}
          onClose={close}
          testId="desktop.camera"
          labels={{
            close: t('core.action.close'),
            shoot: t('core.camera.shoot'),
            retake: t('core.camera.retake'),
            use: t('core.camera.use'),
            switchCamera: t('core.camera.switchCamera'),
            retry: t('core.action.retry'),
            starting: t('core.camera.starting'),
            none: t('core.camera.none'),
            denied: t('core.camera.denied'),
            failed: t('core.camera.failed'),
            saveFailed: t('core.camera.saveFailed'),
          }}
        />
        <VideoRecorderDialog
          open={current?.kind === 'video'}
          title={current?.title ?? ''}
          hint={current?.kind === 'video' ? current.request.hint : ''}
          maxMs={current?.kind === 'video' ? current.request.maxMs : 0}
          maxBytes={VIDEO_MAX_SIZE_BYTES}
          onUse={keepVideo}
          onClose={close}
          testId="desktop.video"
          labels={{
            close: t('core.action.close'),
            start: t('media.video.start'),
            stop: t('media.video.stop'),
            retake: t('media.video.retake'),
            use: t('media.video.use'),
            switchCamera: t('core.camera.switchCamera'),
            retry: t('core.action.retry'),
            starting: t('core.camera.starting'),
            none: t('core.camera.none'),
            denied: t('core.video.denied'),
            failed: t('core.camera.failed'),
            saveFailed: t('core.video.saveFailed'),
            noMicrophone: t('core.video.noMicrophone'),
            tooLarge: t('media.video.tooLarge'),
            time: (elapsed: string, max: string) => t('media.video.time', { elapsed, max }),
          }}
        />
        <VideoPlayerDialog
          open={watching !== null}
          title={watching?.title ?? ''}
          source={watching?.source ?? { kind: 'loading' }}
          onRetry={() => {
            if (playing !== null) loadPlaying(playing);
          }}
          onClose={closePlayer}
          testId="desktop.videoPlayer"
          labels={{
            close: t('core.action.close'),
            loading: t('core.video.loading'),
            retry: t('core.action.retry'),
            unavailable: t('media.video.unavailableBody'),
            failed: t('core.video.failed'),
          }}
        />
        <SignatureDialog
          open={current?.via === 'pc' && current.kind === 'signature'}
          fallback={usePhone() ?? undefined}
          title={current?.title ?? ''}
          onUse={keepSignature}
          onClose={close}
          testId="desktop.signature"
          labels={{
            close: t('core.action.close'),
            hint: t('core.signature.hint'),
            clear: t('core.signature.clear'),
            use: t('core.signature.use'),
            saveFailed: t('core.signature.saveFailed'),
          }}
        />
      </>
    );
  }

  return {
    capture: {
      photo: async (request) => {
        const via = await startVia('photo');
        return new Promise((resolve) =>
          start({ kind: 'photo', title: request?.title ?? '', via, resolve }),
        );
      },
      signature: async (request) => {
        const via = await startVia('signature');
        return new Promise((resolve) =>
          start({ kind: 'signature', title: request?.title ?? '', via, resolve }),
        );
      },
      video: (request) =>
        new Promise((resolve) =>
          start({ kind: 'video', title: request.title, request, via: 'pc', resolve }),
        ),
      play: (request, load) =>
        new Promise((resolve) => {
          closePlayer();
          loadPlaying({ title: request.title, source: { kind: 'loading' }, load, done: resolve });
        }),
    },
    Host,
    waitingSince: () => pendingSince,
    cancel: () => {
      close();
      closePlayer();
    },
  };
}
