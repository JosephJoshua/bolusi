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
import { DomainError, type StorageBand } from '@bolusi/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { CapturedMedia } from '@bolusi/modules/notes/screens';

import type { CameraCapturePort, CaptureIdentity } from './capture.js';
import type { CaptureScreenState } from './CaptureScreen.js';
import type { MediaClient } from './client.js';

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
  readonly capturePhoto: () => Promise<CapturedMedia | null>;
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

/** The one place a non-`DomainError` throw becomes a code the catalog can key off (07-i18n §4.2). */
function codeOf(error: unknown): string {
  return error instanceof DomainError ? error.code : 'UNEXPECTED';
}

export function useCaptureHost(deps: CaptureHostDeps): CaptureHost {
  const [state, setState] = useState<CaptureScreenState | null>(null);
  /** The captured still awaiting the user's "Pakai Foto Ini". Cleared on retake / use / cancel. */
  const [review, setReview] = useState<{
    readonly uri: string;
    readonly media: CapturedMedia;
  } | null>(null);
  const cameraRef = useRef<CameraCapturePort | null>(null);
  const settleRef = useRef<((value: CapturedMedia | null) => void) | null>(null);
  /**
   * The `userId` whose session OPENED the current capture, captured at the shutter's `capturePhoto`
   * call and cleared on settle. This is what makes a capture PER-USER at the composition root, not
   * just at the frozen `mediaRef` (06 §4). A capture is a modal step inside one user's session, and
   * an idle lock can end that session and let a DIFFERENT user unlock underneath a still-open host
   * (`Root` passes `identity: notes?.identity`, which changes when the switch lands). Without this,
   * user B would unlock straight onto user A's live viewfinder, and a shot pressed there would stamp
   * B (via `identityRef`) into A's dead promise — the very cross-user attribution the switcher exists
   * to prevent. Compared by `userId` only: tenant/store/device are the same physical device.
   */
  const openedForUserRef = useRef<string | null>(null);

  const identityRef = useRef<CaptureIdentity | null>(deps.identity);
  identityRef.current = deps.identity;
  const mediaRef = useRef<MediaClient | null>(deps.media);
  mediaRef.current = deps.media;

  /** Close the surface and hand the caller its answer. Idempotent — a double tap resolves once. */
  const settle = useCallback((value: CapturedMedia | null): void => {
    const resolve = settleRef.current;
    settleRef.current = null;
    openedForUserRef.current = null;
    setState(null);
    setReview(null);
    resolve?.(value);
  }, []);

  /**
   * Is the open capture stranded in a DIFFERENT user's session? True only when a capture is open, it
   * was opened by some user, and the acting user is now a different NON-null user.
   *
   * A transient `null` is a LOCK, not a switch — the same user's own lock→unlock goes A → null → A,
   * and the work-retention promise (SwitcherScreen.tsx:7-11, "Pekerjaanmu aman") is that A's PIN
   * returns to A's viewfinder. So `null` never strands: only a landed different user does.
   */
  const strandedUser = deps.identity?.userId ?? null;
  const stranded =
    settleRef.current !== null &&
    openedForUserRef.current !== null &&
    strandedUser !== null &&
    strandedUser !== openedForUserRef.current;

  /**
   * Cancel a capture the acting user walked away from via an idle lock + a foreign unlock.
   *
   * Resolves the awaiting caller (user A's `NoteEditor`, being torn down with A's session anyway) as
   * a cancel and clears the host, so user B lands on their OWN home rather than A's viewfinder. The
   * frame is prevented as well as cleaned up: `surface` below returns `null` while `stranded`, so B
   * never even renders A's camera for a tick.
   */
  useEffect(() => {
    if (stranded) settle(null);
  }, [stranded, settle]);

  /**
   * Enter (or re-enter) the pre-shutter states: permission, then 06 §7's band.
   *
   * THE BAND IS READ HERE AND NOWHERE ELSE. `storageBand()` returns the last pruning pass's verdict
   * (`media/pruning.ts:97` `lastBand: () => band`), and `MediaClient.start()` primes it at boot
   * (`media/client.ts:225`, `this.pruning.run('app_start')`). Stated precisely, because the loose
   * version — "every drain refreshes it" — is not true: the after-drain pass at `client.ts:338` goes
   * through the same `run()`, which RETURNS EARLY WITHOUT touching `band` when §7's once-an-hour
   * throttle applies (`pruning.ts:109-114`). So this can be up to an hour stale while free space is
   * `normal`; it is refreshed promptly exactly when it matters, because that throttle exempts every
   * band below `normal`.
   *
   * `null` means no pass has run yet on this process; treated as `normal` because a band nobody has
   * measured must not raise an alarm. Neither the staleness nor the `null` can under-protect the
   * user, because the REFUSAL is not derived from this value at all: `capture.ts:133-134` re-reads
   * free space at the shutter and returns `refused_low_storage` through core's `isCaptureRefused`,
   * so §7's < 50 MB rule is enforced by the pipeline whatever this banner says.
   */
  const enterReady = useCallback(async (): Promise<void> => {
    const platform = deps.platform;
    if (platform === null) return;
    setState({ kind: 'permission_pending' });
    const granted = await platform.ensurePermission();
    if (settleRef.current === null) return; // Cancelled while the OS dialog was up.
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
  }, [deps.platform]);

  const capturePhoto = useCallback((): Promise<CapturedMedia | null> => {
    if (deps.media === null || deps.platform === null || identityRef.current === null) {
      // The SAME stance as `UNWIRED_NOTES_MEDIA`: reject, never resolve `null`. A device with no
      // media pipeline cannot take evidence photos, and an attach button that quietly behaved like a
      // cancel would be the working-looking lie this whole task is about.
      return Promise.reject(new Error('in-app capture is not available on this device'));
    }
    if (settleRef.current !== null) {
      // A second request while one is open. Refuse rather than replace: replacing would strand the
      // first caller's promise forever, and the notes editor awaits it to set its `mediaRef`.
      return Promise.reject(new Error('a capture is already in progress'));
    }
    const pending = new Promise<CapturedMedia | null>((resolve) => {
      settleRef.current = resolve;
    });
    // Stamp the opening user NOW (see `openedForUserRef`) — `identityRef.current` is non-null here
    // (guarded above), so a later switch has a value to diverge from.
    openedForUserRef.current = identityRef.current?.userId ?? null;
    void enterReady();
    return pending;
  }, [deps.media, deps.platform, enterReady]);

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
    const identity = identityRef.current;
    const camera = cameraRef.current;
    if (media === null || identity === null || camera === null) return;
    setState({ kind: 'capturing' });
    void media
      .capturePhoto(identity, camera)
      .then((outcome) => {
        if (settleRef.current === null) return; // Backed out mid-encode; the orphan row prunes at 24 h.
        if (outcome.kind === 'refused_low_storage') {
          setState({ kind: 'refused_low_storage' });
          return;
        }
        // §2.2 step 5 has already moved the bytes to the document dir, so this uri is the FINAL file
        // the hash was taken over — the review frame shows exactly what the `mediaRef` commits to.
        setReview({ uri: outcome.localPath, media: { mediaRef: outcome.ref } });
        setState({ kind: 'review', previewUri: outcome.localPath });
      })
      .catch((error: unknown) => {
        if (settleRef.current === null) return;
        setState({ kind: 'failed', code: codeOf(error) });
      });
  }, []);

  const surface = useMemo<CaptureSurface | null>(() => {
    // `stranded` wins over `state`: a capture open in a foreign session renders NOTHING, so the
    // incoming user never sees the outgoing user's viewfinder even for the frame before the cancel
    // effect above resets `state`. This is the render-side half of the identity guard.
    if (state === null || deps.platform === null || stranded) return null;
    const platform = deps.platform;
    return {
      state,
      preview:
        state.kind === 'review'
          ? platform.renderStill(state.previewUri)
          : platform.renderPreview(publishCamera),
      onShutter,
      onRetake: () => {
        // Back to the viewfinder. The discarded capture's row + file stay until the pruning pass's
        // 24 h orphan rule collects them (06 §4/§7) — deleting here would be a second deletion path
        // for `media_items`, and `pruning.ts` is the one that exists.
        setReview(null);
        void enterReady();
      },
      onUsePhoto: () => settle(review?.media ?? null),
      onRetry: () => void enterReady(),
      onBack: () => settle(null),
    };
  }, [state, deps.platform, stranded, publishCamera, onShutter, enterReady, settle, review]);

  return { capturePhoto, surface };
}
