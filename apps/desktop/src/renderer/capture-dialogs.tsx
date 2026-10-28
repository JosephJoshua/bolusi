// The counter PC's webcam dialog and signature pad, mounted once in the app. `capture` answers the
// screens' photo and signature asks like the phone's camera and pad do: a JPEG from the webcam, or
// the drawn strokes, and null when the person backs out. A PC without a webcam or touch screen
// hands the step to a store phone instead (`phone-handoff.tsx`), which answers the same way.
// Storing and signing what was taken is the runtime's job.
import { t } from '@bolusi/i18n';
import type { CaptureRequest } from '@bolusi/modules/screen-kit';
import { Button, CameraDialog, SignatureDialog, type DrawnSignature } from '@bolusi/ui-web';
import { Smartphone } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';

import type { HandoffBridge } from '../main/bridge.js';
import { PhoneHandoffDialog, type HandoffResult } from './phone-handoff.js';

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
  /** This PC's webcam or pad, or a store phone. */
  readonly via: 'pc' | 'phone';
};

export interface CaptureDialogs {
  readonly capture: PcCapture;
  /** Mount once, inside the app, to show the dialogs. */
  readonly Host: () => React.JSX.Element;
}

/** `handoff` is the desktop app's phone handoff; without it (a plain browser) there is none. */
export function createCaptureDialogs(handoff?: HandoffBridge): CaptureDialogs {
  let pending: Pending | null = null;
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of listeners) listener();
  };
  const set = (next: Pending | null): void => {
    // One capture at a time: a second ask while one is open cancels the first.
    if (pending !== null && pending !== next) pending.resolve(null);
    pending = next;
    emit();
  };
  const switchTo = (via: Pending['via']): void => {
    if (pending === null) return;
    pending = { ...pending, via };
    emit();
  };
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const close = (): void => set(null);

  const keepPhoto = async (blob: Blob): Promise<void> => {
    const current = pending;
    if (current?.kind !== 'photo') return;
    const photo: WebcamPhoto = {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      mime: 'image/jpeg',
    };
    if (pending !== current) return;
    pending = null;
    current.resolve(photo);
    set(null);
  };
  const keepSignature = (signature: DrawnSignature): Promise<void> => {
    const current = pending;
    if (current?.kind !== 'signature') return Promise.resolve();
    pending = null;
    current.resolve(signature);
    set(null);
    return Promise.resolve();
  };

  const keepFromPhone = (result: HandoffResult): void => {
    const current = pending;
    if (current === null) return;
    pending = null;
    if (current.kind === 'photo' && result.kind === 'photo') {
      current.resolve({ bytes: result.bytes, mime: 'image/jpeg' });
    } else if (current.kind === 'signature' && result.kind === 'signature') {
      current.resolve(result.signature);
    } else {
      current.resolve(null);
    }
    set(null);
  };

  const usePhone =
    handoff === undefined ? undefined : (
      <Button
        label={t('core.handoff.usePhone')}
        icon={Smartphone}
        variant="text"
        onClick={() => switchTo('phone')}
        data-testid="desktop.usePhone"
      />
    );

  function Host(): React.JSX.Element {
    const current = useSyncExternalStore(subscribe, () => pending);
    // A capture still open when the app goes away is backed out of.
    useEffect(() => close, []);
    return (
      <>
        {handoff === undefined ? null : (
          <PhoneHandoffDialog
            handoff={handoff}
            open={current?.via === 'phone'}
            kind={current?.kind ?? 'photo'}
            title={current?.title ?? ''}
            onDone={keepFromPhone}
            onBack={() => switchTo('pc')}
            onClose={close}
          />
        )}
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
      photo: (request) =>
        new Promise((resolve) =>
          set({ kind: 'photo', title: request?.title ?? '', via: 'pc', resolve }),
        ),
      signature: (request) =>
        new Promise((resolve) =>
          set({ kind: 'signature', title: request?.title ?? '', via: 'pc', resolve }),
        ),
    },
    Host,
  };
}
