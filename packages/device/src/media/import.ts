// A picture chosen from the device's gallery (the store logo) entering the media pipeline: the same
// free-space refusal before anything is written and the same finalization tail as a camera capture
// (06 §2.2 steps 5–8), so the signed ref describes the bytes actually on disk. The gallery port has
// already resized the picture into the cache; a PNG stays a PNG so a logo keeps its transparency.
import { isCaptureRefused, type ClockPort, type IdSource, type LocationPort } from '@bolusi/core';
import type { MediaRef } from '@bolusi/schemas';

import type { CaptureOutcome } from './capture.js';
import { finalizeMediaCapture, type FinalizeMediaDeps } from './finalize.js';

/** A picked picture, already resized into the app cache. */
export interface PickedImage {
  readonly uri: string;
  readonly mime: MediaRef['mime'];
}

/** The gallery seam: resolves null when the person backs out of the picker. */
export interface GalleryPort {
  pick(): Promise<PickedImage | null>;
}

export interface ImportDeps<DB> extends FinalizeMediaDeps<DB> {
  readonly location: LocationPort;
  readonly clock: ClockPort;
  readonly newId: IdSource;
  readonly freeSpaceBytes: () => number;
}

export async function importImage<DB>(
  deps: ImportDeps<DB>,
  picked: PickedImage,
): Promise<Exclude<CaptureOutcome, { kind: 'captured' }> | { kind: 'imported'; ref: MediaRef }> {
  const freeBytes = deps.freeSpaceBytes();
  if (isCaptureRefused(freeBytes)) return { kind: 'refused_low_storage', freeBytes };
  const { ref } = await finalizeMediaCapture(deps, {
    sourceUri: picked.uri,
    mediaId: deps.newId(),
    extension: picked.mime === 'image/png' ? 'png' : 'jpg',
    type: 'image',
    mime: picked.mime,
    capturedAt: deps.clock.now(),
    location: deps.location.getBestFix(),
  });
  return { kind: 'imported', ref };
}
