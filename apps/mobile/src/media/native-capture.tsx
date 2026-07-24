/**
 * THE `expo-camera` BINDING for the in-app capture surface (06-media-pipeline §2.1; task 130).
 *
 * The one file in the app that imports `expo-camera`, for the same reason `native.ts` is the one that
 * imports `expo-file-system`: `CameraView` is a native view that cannot mount under Node, so
 * everything above it names only `CapturePlatform` and stays testable. Kept out of `index.ts` because
 * that file is deliberately JSX-free (it calls `Root(...)` rather than rendering it).
 *
 * ── `createExpoCameraCapture` FINALLY HAS A CALLER ──────────────────────────────────────────────
 * Task 18 wrote it, pinned 06 §2.2 step 1's four options in it, documented why each is explicit —
 * and nothing in shipping source ever called it. It was the capture pipeline's own instance of the
 * "sound implementation, zero callers" class (CLAUDE.md §2.11), one layer below the seam this task
 * is here to close. This is its call site; nothing here re-specifies those options.
 *
 * ── WHY THE PORT IS PUBLISHED FROM `onCameraReady`, NOT FROM THE REF CALLBACK ───────────────────
 * The SDK states the precondition for `takePictureAsync` in one sentence: "Make sure to wait for the
 * `onCameraReady` callback before calling this method" (expo-camera SDK 57 docs, retrieved
 * 2026-07-23; the prop exists at `node_modules/expo-camera/build/Camera.types.d.ts:431` and the
 * method at `build/CameraView.d.ts:99`). The ref lands well before the camera is ready, so
 * publishing there would put the host in `ready` — the ONLY state that renders the shutter
 * (`CaptureScreen.tsx:204`) — while the SDK's own precondition was still unmet. Publishing from
 * `onCameraReady` makes that precondition the same event that unlocks the button.
 *
 * WHAT THE DOCS DO **NOT** SAY, recorded because an earlier draft of this comment said it: they do
 * not state that an unready preview throws. The throw they name is a different case — "Avoid calling
 * this method while the preview is PAUSED. On Android, this will throw an error." This file never
 * pauses the preview, so that note does not apply here, and merging the two sentences would have
 * been a fabricated platform rule sitting next to a real one.
 */
import { Camera, CameraView } from 'expo-camera';
import { Image } from 'expo-image';
import { useEffect, useRef } from 'react';
import { StyleSheet } from 'react-native';

import { createExpoCameraCapture, type CameraCapturePort } from './capture.js';
import type { CapturePlatform } from './CaptureHost.js';

/** The live viewfinder, publishing its capture port the moment the SDK says it is safe to shoot. */
function CameraPreview({
  publish,
}: {
  readonly publish: (camera: CameraCapturePort | null) => void;
}): React.JSX.Element {
  const view = useRef<CameraView | null>(null);

  // Unpublish on unmount. Without it the host would keep a port pointing at a torn-down native view,
  // and the next capture would open `ready` (shutter live) against a camera that no longer exists.
  useEffect(() => () => publish(null), [publish]);

  return (
    <CameraView
      ref={(instance) => {
        view.current = instance;
      }}
      style={styles.fill}
      // Evidence photography is rear-camera work (06 §2.1: a technician photographing a handset).
      facing="back"
      onCameraReady={() => {
        const instance = view.current;
        if (instance === null) return;
        publish(createExpoCameraCapture((options) => instance.takePictureAsync(options)));
      }}
      // A mount error means there is no usable camera on this device right now. Unpublishing drops
      // the host back to `warming_up`, which renders no shutter — the honest "you cannot shoot" —
      // rather than a live-looking button over a dead preview.
      onMountError={() => publish(null)}
    />
  );
}

export function createExpoCapturePlatform(): CapturePlatform {
  return {
    async ensurePermission(): Promise<boolean> {
      // `requestCameraPermissionsAsync`, not `getCameraPermissionsAsync`: a first-run device has
      // never been asked, and a read would report `denied` for a permission nobody declined. Both
      // are on the module's public surface (`node_modules/expo-camera/build/index.d.ts:62-67`).
      //
      // The reason `CaptureScreen`'s denied state sends the user to OS settings rather than
      // re-prompting is stated at `CaptureScreen.tsx:33-35` and is NOT re-derived here — this file
      // only has to pick the call that can still succeed on a first run.
      const response = await Camera.requestCameraPermissionsAsync();
      return response.granted;
    },
    renderPreview: (publish) => <CameraPreview publish={publish} />,
    // `expo-image` per design-system §7 ("required for media thumbnails on 2GB RAM" — it downsamples
    // to layout size). `contain` so the review frame shows the whole photo that was taken: a `cover`
    // crop would hide damage at the edge of the frame, on the one screen whose job is confirming the
    // damage is in frame.
    renderStill: (uri) => <Image source={{ uri }} style={styles.fill} contentFit="contain" />,
  };
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
