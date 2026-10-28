// The counter PC's webcam dialog and signature pad, mounted once in the app. `capture` answers the
// screens' photo and signature asks like the phone's camera and pad do: a JPEG from the webcam, or
// the drawn strokes, and null when the person backs out. A PC without a webcam, or without a touch
// screen for signing, hands the step to a paired store phone instead (`phone-handoff.tsx`), which
// answers the same way; one scan covers every step after it. Storing and signing what was taken
// is the runtime's job.
import { t } from '@bolusi/i18n';
import type { CaptureRequest } from '@bolusi/modules/screen-kit';
import { Button, CameraDialog, SignatureDialog, type DrawnSignature } from '@bolusi/ui-web';
import { Smartphone } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';

import type { HandoffBridge } from '../main/bridge.js';
import { PhoneHandoffDialog, PhoneLinkStore, type HandoffResult } from './phone-handoff.js';

export interface WebcamPhoto {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mime: 'image/jpeg';
}

/** What this PC can take: a webcam photo, or a signature drawn on screen. */
export interface PcCapture {
  photo(request?: CaptureRequest): Promise<WebcamPhoto | null>;
  signature(request?: CaptureRequest): Promise<DrawnSignature | null>;
}

type Pending = (
  | {
      readonly kind: 'photo';
      readonly resolve: (photo: WebcamPhoto | null) => void;
    }
  | {
      readonly kind: 'signature';
      readonly resolve: (signature: DrawnSignature | null) => void;
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
}

async function hasWebcam(): Promise<boolean> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.some((device) => device.kind === 'videoinput');
  } catch {
    return false;
  }
}

/** A finger or pen to sign with; a mouse alone makes a poor signature. */
const hasTouch = (): boolean =>
  typeof window.matchMedia === 'function' && window.matchMedia('(any-pointer: coarse)').matches;

/** `handoff` is the desktop app's phone handoff; without it (a plain browser) there is none. */
export function createCaptureDialogs(handoff?: HandoffBridge): CaptureDialogs {
  const phone = handoff === undefined ? null : new PhoneLinkStore(handoff);
  let pending: Pending | null = null;
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  /** Ends the open capture with `value`, and closes its dialog. */
  const settle = (value: WebcamPhoto | DrawnSignature | null): void => {
    const current = pending;
    if (current === null) return;
    pending = null;
    phone?.withdraw();
    (current.resolve as (value: WebcamPhoto | DrawnSignature | null) => void)(value);
    emit();
  };
  const close = (): void => settle(null);

  /** Hands the open capture to the phone; what it sends ends the capture. */
  const onPhone = (current: Pending): void => {
    if (phone === null) return;
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
    if (phone === null) return 'pc';
    if (phone.paired) return 'phone';
    return (kind === 'photo' ? await hasWebcam() : hasTouch()) ? 'pc' : 'phone';
  };

  const keepPhoto = async (blob: Blob): Promise<void> => {
    const current = pending;
    if (current?.kind !== 'photo') return;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (pending === current) settle({ bytes, mime: 'image/jpeg' });
  };
  const keepSignature = (signature: DrawnSignature): Promise<void> => {
    if (pending?.kind === 'signature') settle(signature);
    return Promise.resolve();
  };

  const usePhone =
    phone === null ? undefined : (
      <Button
        label={t('core.handoff.usePhone')}
        icon={Smartphone}
        variant="text"
        onClick={() => switchTo('phone')}
        data-testid="desktop.usePhone"
      />
    );

  const noLink = { state: 'none' } as const;
  const noSubscribe = (): (() => void) => () => undefined;

  function Host(): React.JSX.Element {
    const current = useSyncExternalStore(subscribe, () => pending);
    const link = useSyncExternalStore(phone?.subscribe ?? noSubscribe, () =>
      phone === null ? noLink : phone.snapshot(),
    );
    // A capture still open when the app goes away is backed out of, and the phone let go.
    useEffect(
      () => () => {
        close();
        phone?.close();
      },
      [],
    );
    return (
      <>
        <PhoneHandoffDialog
          open={current?.via === 'phone'}
          link={link}
          kind={current?.kind ?? 'photo'}
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
          fallback={usePhone}
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
        <SignatureDialog
          open={current?.via === 'pc' && current.kind === 'signature'}
          fallback={usePhone}
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
    },
    Host,
  };
}
