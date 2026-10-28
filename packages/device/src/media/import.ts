// A picture chosen from the device's gallery (the store logo) entering the media pipeline: the same
// free-space refusal before anything is written and the same finalization tail as a camera capture
// (06 §2.2 steps 5–8), so the signed ref describes the bytes actually on disk. The gallery port has
// already resized the picture into the cache; a PNG stays a PNG so a logo keeps its transparency.
// A recorded video clip enters the same way: the recorder has written it to the cache, and this keeps
// it (sealed, hashed, queued) as it is. Nothing transcodes a clip.
import { isCaptureRefused, type ClockPort, type IdSource, type LocationPort } from '@bolusi/core';
import {
  MEDIA_EXTENSION,
  VIDEO_MAX_SIZE_BYTES,
  type MediaRef,
  type VideoMime,
  type VideoRef,
} from '@bolusi/schemas';

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
  const { ref } = await finalizeMediaCapture<DB, MediaRef>(deps, {
    sourceUri: picked.uri,
    mediaId: deps.newId(),
    extension: MEDIA_EXTENSION[picked.mime],
    type: 'image',
    mime: picked.mime,
    capturedAt: deps.clock.now(),
    location: deps.location.getBestFix(),
  });
  return { kind: 'imported', ref };
}

/** A recorded clip, still in the app cache (or the PC's capture scratch). */
export interface RecordedVideo {
  readonly uri: string;
  readonly mime: VideoMime;
}

export async function importVideo<DB>(
  deps: ImportDeps<DB>,
  recorded: RecordedVideo,
): Promise<
  | Exclude<CaptureOutcome, { kind: 'captured' }>
  | { kind: 'refused_too_large'; sizeBytes: number }
  | { kind: 'imported'; ref: VideoRef }
> {
  // A clip not kept is the customer on camera, unencrypted: it goes at once, whatever the reason.
  const drop = (): Promise<void> => deps.files.deleteFile(recorded.uri).catch(() => undefined);
  const freeBytes = deps.freeSpaceBytes();
  if (isCaptureRefused(freeBytes)) {
    await drop();
    return { kind: 'refused_low_storage', freeBytes };
  }
  // A camera that ignored the bitrate asked for: the server would refuse it for good.
  const sizeBytes = await deps.files.sizeOf(recorded.uri);
  if (sizeBytes > VIDEO_MAX_SIZE_BYTES) {
    await drop();
    return { kind: 'refused_too_large', sizeBytes };
  }
  try {
    const { ref } = await finalizeMediaCapture<DB, VideoRef>(deps, {
      sourceUri: recorded.uri,
      mediaId: deps.newId(),
      extension: MEDIA_EXTENSION[recorded.mime],
      type: 'video',
      mime: recorded.mime,
      capturedAt: deps.clock.now(),
      location: deps.location.getBestFix(),
    });
    return { kind: 'imported', ref };
  } catch (error) {
    await drop();
    throw error;
  }
}
