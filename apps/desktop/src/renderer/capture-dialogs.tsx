// The counter PC's webcam dialog and signature pad, mounted once in the app. `capture` answers the
// screens' photo and signature asks like the phone's camera and pad do: a JPEG from the webcam, or
// the drawn strokes, and null when the person backs out. Storing and signing what was taken is the
// runtime's job.
import { t } from '@bolusi/i18n';
import { Button, CameraDialog, SignatureDialog, type DrawnSignature } from '@bolusi/ui-web';
import { FileImage } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';

import { pickPhotoFile, type PcCapture, type PcPhoto } from './capture.js';

type Pending =
  | {
      readonly kind: 'photo';
      readonly title: string;
      readonly resolve: (photo: PcPhoto | null) => void;
    }
  | {
      readonly kind: 'signature';
      readonly title: string;
      readonly resolve: (signature: DrawnSignature | null) => void;
    };

export interface CaptureDialogs {
  readonly capture: PcCapture;
  /** Mount once, inside the app, to show the dialogs. */
  readonly Host: () => React.JSX.Element;
}

export function createCaptureDialogs(): CaptureDialogs {
  let pending: Pending | null = null;
  const listeners = new Set<() => void>();
  const set = (next: Pending | null): void => {
    // One capture at a time: a second ask while one is open cancels the first.
    if (pending !== null && pending !== next) pending.resolve(null);
    pending = next;
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const close = (): void => set(null);

  const keepPicture = (photo: PcPhoto | null): void => {
    const current = pending;
    if (current?.kind !== 'photo' || photo === null) return;
    pending = null;
    current.resolve(photo);
    set(null);
  };
  const keepPhoto = async (blob: Blob): Promise<void> => {
    const current = pending;
    if (current?.kind !== 'photo') return;
    const photo: PcPhoto = { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/jpeg' };
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

  function Host(): React.JSX.Element {
    const current = useSyncExternalStore(subscribe, () => pending);
    // A capture still open when the app goes away is backed out of.
    useEffect(() => close, []);
    return (
      <>
        <CameraDialog
          open={current?.kind === 'photo'}
          title={current?.title ?? ''}
          onUse={keepPhoto}
          onClose={close}
          // No webcam, or Windows refused it: a photo saved on this PC still works.
          fallback={
            <Button
              label={t('core.camera.fromFile')}
              icon={FileImage}
              onClick={() => void pickPhotoFile().then(keepPicture, () => undefined)}
              data-testid="desktop.camera.file"
            />
          }
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
          open={current?.kind === 'signature'}
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
        new Promise((resolve) => set({ kind: 'photo', title: request?.title ?? '', resolve })),
      signature: (request) =>
        new Promise((resolve) => set({ kind: 'signature', title: request?.title ?? '', resolve })),
    },
    Host,
  };
}
