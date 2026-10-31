/**
 * THE IN-APP CAMERA ENTRY POINT (06-media-pipeline §2.1) — the production consumer `CaptureScreen`,
 * `MediaClient.capturePhoto()` and `MediaClient.storageBand()` never had (task 130).
 *
 * ── WHAT WAS MISSING, PRECISELY ─────────────────────────────────────────────────────────────────
 * Task 18 built the capture pipeline. Task 82 built `MediaClient` around it and said so plainly in
 * its own header: "nothing in a shipping USER FLOW calls `capturePhoto`". Task 96/119 built the
 * notes editor's attach button and bound it to `UNWIRED_NOTES_MEDIA.capturePhoto`, which REJECTS.
 * Task 116 built `CaptureScreen`, reachable only from the web gallery. Every piece existed and no
 * line joined them, so 06 §7's storage banners had never rendered on a device and the attach button
 * threw. Tasks 18 and 82 are both `done`, which is how this became nobody's (task 130's deliverable 3).
 *
 * This hook is the joint. It owns the small state machine between "a screen asked for a photo" and
 * "here is the `mediaRef`", and NOTHING ELSE: no compression, no hashing, no free-space rule, no
 * band thresholds. All of those already have one home (`capture.ts`, `pruning.ts`, core's `bandFor`)
 * and this file calls them rather than restating them (§2.8).
 *
 * ── WHY A HOOK RETURNING A SURFACE, AND NOT A SCREEN ────────────────────────────────────────────
 * `NotesRuntime.capturePhoto()` is a PROMISE. Opening a screen is React state. Something has to hold
 * the deferred across the mount, and that something must live above both the notes surface and the
 * capture surface — i.e. at the composition root. So the hook returns two halves: `capturePhoto`
 * (the seam `createNotes` binds) and `surface` (what the shell renders while a capture is running).
 * `App` supplies the chrome slots, because `App` is where the chrome is built.
 *
 * ── EVERY NATIVE THING IS A PORT (08 §3.2) ──────────────────────────────────────────────────────
 * `expo-camera`'s permission hook, its `CameraView`, and the still-image renderer arrive as
 * {@link CapturePlatform}. That is what makes this file — the one that cannot run without a phone —
 * run under Node in the composed test lane, which is the only place the wiring can be watched
 * working. "Typed and compiling" is not "running on the target" (CLAUDE.md §2.11), and the honest
 * ceiling is stated: what the composed test proves is that the SHELL calls the pipeline and renders
 * its answers. That a real `CameraView` hands back a real JPEG is D12/D13's, not this lane's.
 */
import { errorCodeOrUnexpected, type StorageBand } from '@bolusi/core';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { CaptureRequest, CapturedMedia, PhotoCapture } from '@bolusi/modules/screen-kit';

import type { CameraCapturePort, CaptureIdentity } from '@bolusi/device/media/capture';
import type { CaptureScreenState } from './CaptureScreen.js';
import type { MediaClient } from '@bolusi/device/media/client';
import { usePendingCapture } from './pending-capture.js';

/** The native seams this host needs, bound at `index.ts` (the one `expo-camera` site). */
export interface CapturePlatform {
  /**
   * Ask the OS for the camera permission and report whether it is granted (06 §2.1 needs the live
   * camera; there is no gallery fallback by design — `expo-image-picker` is a banned import).
   *
   * The ADAPTER decides whether that means "read the current status" or "prompt": Android answers a
   * second request on a permanently-denied permission without showing the user anything, which is
   * why `CaptureScreen`'s denied state sends them to OS settings rather than prompting again.
   */
  ensurePermission(): Promise<boolean>;
  /**
   * The live viewfinder. `publish` receives the capture port when the native view is ready and
   * `null` when it goes away — the host stays in `warming_up` until it arrives, so the shutter can
   * never be pressed against a camera that is not there.
   */
  renderPreview(publish: (camera: CameraCapturePort | null) => void): ReactNode;
  /** The captured still, for the `review` state. `expo-image` on a device (design-system §7). */
  renderStill(uri: string): ReactNode;
}

/** What the shell renders while a capture is in flight. `null` ⇒ no capture is running. */
export interface CaptureSurface {
  /** The caller's already-localized title for this shot ("Foto depan"), or null for the default. */
  readonly title: string | null;
  readonly state: CaptureScreenState;
  readonly preview: ReactNode;
  readonly onShutter: () => void;
  readonly onRetake: () => void;
  readonly onUsePhoto: () => void;
  readonly onRetry: () => void;
  readonly onBack: () => void;
}

export interface CaptureHost {
  /**
   * The `NotesRuntime['capturePhoto']` seam. Resolves the captured `mediaRef`, or `null` when the
   * user backed out — `null` is the port's CANCEL value and is never used for a failure, which is the
   * distinction `UNWIRED_NOTES_MEDIA` exists to protect (a stub resolving `null` would make the
   * attach button silently report success).
   */
  readonly capturePhoto: PhotoCapture;
  readonly surface: CaptureSurface | null;
}

export interface CaptureHostDeps {
  /** `null` on a device with no media pipeline (never enrolled) — then `capturePhoto` rejects. */
  readonly media: MediaClient | null;
  /** `null` under Node / a build with no camera binding — then `capturePhoto` rejects. */
  readonly platform: CapturePlatform | null;
  /**
   * Whose photo this is (06 §4: frozen at capture). Read at the moment of the SHUTTER through a ref,
   * never captured when the host was built: this device is PIN-switched all day (PRD-011 §2), and a
   * stale identity would stamp the first user of the morning onto every photo the shop takes — into
   * a signed, immutable `mediaRef` with no UPDATE path.
   */
  readonly identity: CaptureIdentity | null;
}

export function useCaptureHost(deps: CaptureHostDeps): CaptureHost {
  const [state, setState] = useState<CaptureScreenState | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  /** The captured still awaiting the user's "Pakai foto ini". Cleared on retake / use / cancel. */
  const [review, setReview] = useState<{
    readonly uri: string;
    readonly media: CapturedMedia;
  } | null>(null);
  const cameraRef = useRef<CameraCapturePort | null>(null);
  const mediaRef = useRef<MediaClient | null>(deps.media);
  mediaRef.current = deps.media;

  /**
   * The deferred and its per-user guard (`pending-capture.ts`). The identity is read at the
   * SHUTTER, never when the host was built: this device is PIN-switched all day (PRD-011 §2), and a
   * stale identity would stamp the first user of the morning onto every photo, into a signed,
   * immutable `mediaRef`. A capture left open across an idle lock into a DIFFERENT user's session
   * is cancelled, and its viewfinder never renders for the incoming user.
   */
  const pending = usePendingCapture(deps.identity, () => {
    setState(null);
    setTitle(null);
    setReview(null);
  });
  const { open, settle, isOpen, identity: actingIdentity, stranded } = pending;

  /**
   * Enter (or re-enter) the pre-shutter states: permission, then 06 §7's band.
   *
   * THE BAND IS READ HERE AND NOWHERE ELSE. `storageBand()` returns the last pruning pass's verdict,
   * which can be up to an hour stale while free space is `normal` and is refreshed promptly below
   * it. `null` (no pass yet) reads as `normal`. Neither can under-protect the user: the REFUSAL is
   * re-derived from free space at the shutter (`capture.ts`), whatever this banner says.
   */
  const enterReady = useCallback(async (): Promise<void> => {
    const platform = deps.platform;
    if (platform === null) return;
    setState({ kind: 'permission_pending' });
    const granted = await platform.ensurePermission();
    if (!isOpen()) return; // Cancelled while the OS dialog was up.
    if (!granted) {
      setState({ kind: 'permission_denied' });
      return;
    }
    const band: StorageBand = mediaRef.current?.storageBand() ?? 'normal';
    if (band === 'capture_refused') {
      // §7: a refusal is a whole screen with an explicit dialog, never a banner over a live
      // viewfinder that implies a shutter which does nothing (CaptureScreen's `storageBanner`).
      setState({ kind: 'refused_low_storage' });
      return;
    }
    setState(cameraRef.current === null ? { kind: 'warming_up' } : { kind: 'ready', band });
  }, [deps.platform, isOpen]);

  const capturePhoto = useCallback(
    (request?: CaptureRequest): Promise<CapturedMedia | null> => {
      if (deps.media === null || deps.platform === null || actingIdentity() === null) {
        // Reject, never resolve `null`: a device with no media pipeline cannot take evidence
        // photos, and a button that quietly behaved like a cancel would be a working-looking lie.
        return Promise.reject(new Error('in-app capture is not available on this device'));
      }
      if (isOpen()) return open(); // Rejects: one capture at a time.
      const opened = open();
      setTitle(request?.title ?? null);
      void enterReady();
      return opened;
    },
    [deps.media, deps.platform, enterReady, open, isOpen, actingIdentity],
  );

  /**
   * The published camera port. Publishing PROMOTES `warming_up` → `ready`, which is what makes
   * "the shutter cannot be pressed against a camera that is not there" structural rather than a
   * null-check at the shutter: `bottomAction` only renders the button for `ready`/`capturing`.
   */
  const publishCamera = useCallback((camera: CameraCapturePort | null): void => {
    cameraRef.current = camera;
    setState((current) => {
      if (current === null) return current;
      if (camera === null && current.kind === 'ready') return { kind: 'warming_up' };
      if (camera !== null && current.kind === 'warming_up') {
        return { kind: 'ready', band: mediaRef.current?.storageBand() ?? 'normal' };
      }
      return current;
    });
  }, []);

  const onShutter = useCallback((): void => {
    const media = mediaRef.current;
    const identity = actingIdentity();
    const camera = cameraRef.current;
    if (media === null || identity === null || camera === null) return;
    setState({ kind: 'capturing' });
    void media
      .capturePhoto(identity, camera)
      .then((outcome) => {
        if (!isOpen()) return; // Backed out mid-encode; the orphan row prunes at 24 h.
        if (outcome.kind === 'refused_low_storage') {
          setState({ kind: 'refused_low_storage' });
          return;
        }
        // The saved file is ENCRYPTED at rest (task 158), so the image view cannot read it: showing
        // `outcome.localPath` gave an empty frame. Render it the way every thumbnail is rendered, as
        // a decrypted copy checked against the hash the `mediaRef` commits to, so the review frame
        // shows exactly the bytes that will be signed.
        const ref = outcome.ref;
        return media
          .loadForRender({ mediaId: ref.mediaId, sha256: ref.sha256, mime: ref.mime })
          .then((rendered) => {
            if (!isOpen()) return;
            if (rendered.kind !== 'local' && rendered.kind !== 'cached') {
              setState({ kind: 'failed', code: 'STORAGE_ERROR' });
              return;
            }
            setReview({ uri: rendered.uri, media: { mediaRef: ref } });
            setState({ kind: 'review', previewUri: rendered.uri });
          });
      })
      .catch((error: unknown) => {
        if (!isOpen()) return;
        setState({ kind: 'failed', code: errorCodeOrUnexpected(error) });
      });
  }, [actingIdentity, isOpen]);

  const surface = useMemo<CaptureSurface | null>(() => {
    // `stranded` wins over `state`: a capture open in a foreign session renders NOTHING, so the
    // incoming user never sees the outgoing user's viewfinder even for one frame.
    if (state === null || deps.platform === null || stranded) return null;
    const platform = deps.platform;
    return {
      title,
      state,
      preview:
        state.kind === 'review'
          ? platform.renderStill(state.previewUri)
          : platform.renderPreview(publishCamera),
      onShutter,
      onRetake: () => {
        // Back to the viewfinder. The discarded capture's row + file stay until the pruning pass's
        // 24 h orphan rule collects them (06 §4/§7) — `pruning.ts` is the one deletion path.
        setReview(null);
        void enterReady();
      },
      onUsePhoto: () => settle(review?.media ?? null),
      onRetry: () => void enterReady(),
      onBack: () => settle(null),
    };
  }, [state, title, deps.platform, stranded, publishCamera, onShutter, enterReady, settle, review]);

  return { capturePhoto, surface };
}
