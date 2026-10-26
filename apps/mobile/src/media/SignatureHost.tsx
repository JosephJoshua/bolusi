// The in-app signature pad entry point (06 §2.3): the production caller of
// `MediaClient.captureSignature`. Like `CaptureHost` it holds the deferred a screen awaits and
// hands the shell a surface to render while the customer signs.
import type { CaptureRequest, CapturedMedia, SignatureCapture } from '@bolusi/modules/screen-kit';
import { errorCodeOrUnexpected } from '@bolusi/core';
import { useCallback, useMemo, useRef, useState } from 'react';

import type { CaptureIdentity } from './capture.js';
import type { MediaClient } from './client.js';
import { usePendingCapture } from './pending-capture.js';
import type { SignaturePadState } from './SignaturePadScreen.js';
import type { PadSize, SignaturePoint, SignatureStroke } from './signature-png.js';

/** What the shell renders while a signature is being taken. `null` ⇒ none is. */
export interface SignatureSurface {
  readonly title: string;
  readonly state: SignaturePadState;
  readonly strokes: readonly SignatureStroke[];
  readonly onStrokeStart: (point: SignaturePoint) => void;
  readonly onStrokeMove: (point: SignaturePoint) => void;
  readonly onStrokeEnd: () => void;
  readonly onClear: () => void;
  readonly onSave: () => void;
  readonly onRetry: () => void;
  readonly onBack: () => void;
  readonly onPadLayout: (pad: PadSize) => void;
}

export interface SignatureHost {
  /** Resolves the signed PNG's `mediaRef`, or `null` when the user backed out. */
  readonly captureSignature: SignatureCapture;
  readonly surface: SignatureSurface | null;
}

export interface SignatureHostDeps {
  /** `null` on a device with no media pipeline; then `captureSignature` rejects. */
  readonly media: MediaClient | null;
  readonly identity: CaptureIdentity | null;
}

export function useSignatureHost(deps: SignatureHostDeps): SignatureHost {
  const [title, setTitle] = useState<string | null>(null);
  const [state, setState] = useState<SignaturePadState>({ kind: 'ready' });
  const [strokes, setStrokes] = useState<readonly SignatureStroke[]>([]);
  const padRef = useRef<PadSize | null>(null);
  const mediaRef = useRef<MediaClient | null>(deps.media);
  mediaRef.current = deps.media;

  const pending = usePendingCapture(deps.identity, () => {
    setTitle(null);
    setState({ kind: 'ready' });
    setStrokes([]);
  });
  const { open, settle, isOpen, identity: actingIdentity, stranded } = pending;

  const captureSignature = useCallback(
    (request: CaptureRequest): Promise<CapturedMedia | null> => {
      if (deps.media === null || actingIdentity() === null) {
        return Promise.reject(new Error('signature capture is not available on this device'));
      }
      if (isOpen()) return open(); // Rejects: one capture at a time.
      const opened = open();
      setTitle(request.title);
      return opened;
    },
    [deps.media, actingIdentity, isOpen, open],
  );

  const onSave = useCallback((): void => {
    const media = mediaRef.current;
    const identity = actingIdentity();
    const pad = padRef.current;
    if (media === null || identity === null || pad === null) return;
    setState({ kind: 'saving' });
    void media
      .captureSignature(identity, strokes, pad)
      .then((outcome) => {
        if (!isOpen()) return;
        if (outcome.kind === 'captured') settle({ mediaRef: outcome.ref });
        else if (outcome.kind === 'refused_low_storage') setState({ kind: 'refused_low_storage' });
        // An empty pad cannot be saved (the button is disabled); if it gets here, let them sign.
        else setState({ kind: 'ready' });
      })
      .catch((error: unknown) => {
        if (isOpen()) setState({ kind: 'failed', code: errorCodeOrUnexpected(error) });
      });
  }, [actingIdentity, isOpen, settle, strokes]);

  const surface = useMemo<SignatureSurface | null>(() => {
    if (title === null || stranded) return null;
    return {
      title,
      state,
      strokes,
      onStrokeStart: (point) => setStrokes((current) => [...current, [point]]),
      onStrokeMove: (point) =>
        setStrokes((current) => {
          const last = current[current.length - 1];
          return last === undefined ? current : [...current.slice(0, -1), [...last, point]];
        }),
      onStrokeEnd: () => undefined,
      onClear: () => setStrokes([]),
      onSave,
      onRetry: () => setState({ kind: 'ready' }),
      onBack: () => settle(null),
      onPadLayout: (pad) => {
        padRef.current = pad;
      },
    };
  }, [title, stranded, state, strokes, onSave, settle]);

  return { captureSignature, surface };
}
