// The capture pipeline — 06-media-pipeline §2.2, steps 1–8, in the order the spec numbers them.
//
// THE ORDER IS THE SPEC AND IT IS SECURITY, NOT STYLE. Three of the eight steps only mean anything
// in sequence:
//   • the free-space check happens BEFORE the shutter (06 §7: "checked … before each capture"), so
//     a full device refuses with a dialog instead of dying silently in the camera — PRD-012 §6's
//     "will be discovered at the worst moment";
//   • the cache→document MOVE happens before the row INSERT (§2.2 step 5, §10), so a crash between
//     them "loses the photo cleanly, never a dangling row" pointing into an OS-purgeable directory;
//   • the HASH is taken after the move, over the FINAL bytes, and the file is never touched again
//     (§2.2 step 6) — that hash is what the op's Ed25519 signature binds the evidence to (§3.1), so
//     hashing a file that is about to move is hashing something that will not exist.
// `capture.test.ts` asserts the ORDER, not just the outcome.
//
// EVERYTHING EFFECTFUL IS A PORT (08 §3.2). The camera, the encoder, the filesystem, the clock, the
// id source, the GPS and the DB all arrive as interfaces, so this whole file — the thing that
// cannot run without a phone — runs under Node with no phone. That is what makes the assertions
// below real rather than aspirational; see `capture.test.ts` for what it can and cannot prove.
//
// T-19 IS THE LIVE HAZARD HERE and this file is written against it. A capture path is full of reads
// that can fail: a missing EXIF field, an absent dimension, a failed stat. Not one value below is
// defaulted with `??` — `sizeOf`/`hashFile` REJECT on a missing file (files.ts), a null GPS fix is
// carried as `null` because that is the truth (05 §2.1), and the encoder's own width/height are
// used rather than the ones we asked for. A plausible wrong number in a `mediaRef` is worse than an
// error: it is signed, and a human later reads it as evidence about evidence.
import {
  isCaptureRefused,
  type ClockPort,
  type IdSource,
  type LocationPort,
  type MediaFilePort,
} from '@bolusi/core';
import type { MediaRef } from '@bolusi/schemas';
import type { Kysely } from 'kysely';

import {
  CAPTURE_QUALITY,
  compressCapture,
  type CompressionResult,
  type ImageCompressorPort,
} from './compression.js';
import { insertMediaItem } from './queue.js';

/** JPEG extension for the document-dir filename (06 §2.2 step 5: `<documentDirectory>/media/<id>.jpg`). */
const PHOTO_EXTENSION = 'jpg';

/** A raw shot straight out of `takePictureAsync`, still in the app CACHE directory. */
export interface CameraShot {
  readonly uri: string;
  readonly width: number;
  readonly height: number;
}

/**
 * The camera seam. The ADAPTER applies 06 §2.2 step 1's pinned options — a port that took them as
 * arguments would let each call site pick its own, which is how `quality` silently becomes SDK 57's
 * default of `1` (a maximal JPEG) on one screen and 0.7 on another.
 */
export interface CameraCapturePort {
  takePicture(): Promise<CameraShot>;
}

/** The device identity frozen onto every captured row (06 §4: "frozen at capture"). */
export interface CaptureIdentity {
  readonly tenantId: string;
  /** Null for store-less devices (api/03-media §2). */
  readonly storeId: string | null;
  readonly userId: string;
  readonly deviceId: string;
}

export interface CaptureDeps<DB> {
  readonly db: Kysely<DB>;
  /**
   * Passed per call rather than closed over at construction: this device is SHARED and PIN-switched
   * (PRD-011 §2), so a capture must stamp whoever is signed in NOW. A cached identity would freeze
   * the first user of the morning onto every photo the shop takes — into a signed, immutable
   * `mediaRef` (06 §4: "no UPDATE path exists").
   */
  readonly identity: CaptureIdentity;
  readonly camera: CameraCapturePort;
  readonly compressor: ImageCompressorPort;
  readonly files: MediaFilePort;
  /** `moveCaptureToDocumentDir` (files.ts) — injected so the ordering is assertable under Node. */
  readonly moveToDocuments: (
    cacheUri: string,
    mediaId: string,
    extension: string,
  ) => Promise<string>;
  readonly location: LocationPort;
  readonly clock: ClockPort;
  /** UUIDv7 source (05 §2.1) — the same one the command runtime uses. */
  readonly newId: IdSource;
  /** Free bytes, for §7's bands. `Paths.availableDiskSpace`, never the throwing legacy API. */
  readonly freeSpaceBytes: () => number;
  /**
   * 06 §5.2 (b): "debounced 3 s after any capture". Fired AFTER the row is committed — a trigger
   * before the INSERT would run a drain pass that cannot see the item it was fired for.
   */
  readonly onCaptured: () => void;
}

/**
 * What a capture attempt produced.
 *
 * `refused_low_storage` is a first-class OUTCOME rather than a thrown error because 06 §7 requires
 * the UI to show "an explicit error dialog — never a silent camera failure", and an exception is
 * exactly the shape that gets swallowed by a generic catch and rendered as nothing.
 */
export type CaptureOutcome =
  | {
      readonly kind: 'captured';
      readonly ref: MediaRef;
      /** Document-dir path of the final bytes. */
      readonly localPath: string;
      /** 1 or 2 (06 §2.2 step 4) — surfaced so a test can assert WHICH rule fired. */
      readonly passes: CompressionResult['passes'];
    }
  | { readonly kind: 'refused_low_storage'; readonly freeBytes: number };

/**
 * 06 §2.2, steps 1–8.
 *
 * Returns the `mediaRef` (§3.2) for the calling command to embed in its op payload. The command
 * runtime sets `attachedToOperationId` when the op is appended (04 §5.1 step 5, `attachMediaToOperation`
 * in queue.ts); until then the row is an ORPHAN by design and the pruning pass will remove it after
 * 24 h if the command is abandoned (§4). That is the correct behaviour for a user who opens the
 * camera and backs out — the bytes do not linger, and the drain never uploads them (its predicate
 * is `attached_to_operation_id IS NOT NULL`, so evidence with no signed claim never leaves the device).
 */
export async function capturePhoto<DB>(deps: CaptureDeps<DB>): Promise<CaptureOutcome> {
  // §7, BEFORE the shutter. `isCaptureRefused` is core's — the band logic has one home.
  const freeBytes = deps.freeSpaceBytes();
  if (isCaptureRefused(freeBytes)) return { kind: 'refused_low_storage', freeBytes };

  // Step 1 — the shutter. The pinned options live in the adapter (see `CameraCapturePort`).
  const shot = await deps.camera.takePicture();

  // Step 2 — the GPS fix, best-available or null, NEVER blocking (05 §2.1; the LocationPort is
  // synchronous precisely so this line cannot wait on a satellite).
  const capturedAt = deps.clock.now();
  const location = deps.location.getBestFix();

  // Steps 3–4 — the two pinned passes.
  const compressed = await compressCapture(
    { compressor: deps.compressor, sizeOf: (path) => deps.files.sizeOf(path) },
    shot.uri,
    { width: shot.width, height: shot.height },
  );

  // Step 5 — cache → document dir, AWAITED, before anything references the file.
  const mediaId = deps.newId();
  const localPath = await deps.moveToDocuments(compressed.uri, mediaId, PHOTO_EXTENSION);

  // Step 6 — hash the FINAL bytes at their FINAL path. Both reads reject on a missing file, so a
  // move that silently did nothing surfaces here as an error rather than as the empty-string
  // SHA-256 the drain would later report as `HASH_MISMATCH` ("your evidence rotted").
  const sha256 = await deps.files.hashFile(localPath);
  const sizeBytes = await deps.files.sizeOf(localPath);

  // Step 7 — the row.
  await insertMediaItem(deps.db, {
    id: mediaId,
    tenantId: deps.identity.tenantId,
    storeId: deps.identity.storeId,
    userId: deps.identity.userId,
    deviceId: deps.identity.deviceId,
    type: 'image',
    mime: 'image/jpeg',
    sizeBytes,
    sha256,
    capturedAt,
    location,
    localPath,
  });

  // 06 §5.2 (b). After the commit, so the pass it schedules can see the row.
  deps.onCaptured();

  // Step 8 — the ref the command embeds. `sizeBytes`/`sha256` are the MEASURED values, not the
  // compressor's report: the op signature covers them, and they must describe the bytes on disk.
  return {
    kind: 'captured',
    localPath,
    passes: compressed.passes,
    ref: {
      mediaId,
      sha256,
      mime: 'image/jpeg',
      type: 'image',
      sizeBytes,
      capturedAt,
      location,
      userId: deps.identity.userId,
      deviceId: deps.identity.deviceId,
    },
  };
}

/**
 * The `expo-camera` binding for `CameraCapturePort` — 06 §2.2 step 1's options, pinned here.
 *
 * `quality` MUST be explicit: the SDK 57 default is `1` (a maximal JPEG straight off an 8–12 MP
 * sensor), which is the single largest thing this pipeline exists to avoid on a 2 GB device.
 * `skipProcessing: false` keeps the orientation fix — the SDK's own docs warn that skipping it
 * "would cause orientation uncertainty" and that some Sony/Samsung devices return sideways frames.
 * `exif: false` because metadata is bound cryptographically, never byte-embedded (06 §3.1), and
 * `base64: false` because a base64 copy of a 300 KiB photo in JS memory buys nothing.
 *
 * `takePictureAsync` resolves with `CameraCapturedPicture | undefined` in the SDK 57 typings
 * (CameraView.d.ts) — the `undefined` arm is real (it is what the `onPictureSaved` callback form
 * returns) and is rejected here rather than defaulted. `?? { uri: '' }` on this line would hand the
 * rest of the pipeline a path that does not exist and produce a row pointing nowhere (T-19).
 */
export function createExpoCameraCapture(
  takePictureAsync: (options: {
    quality: number;
    exif: boolean;
    base64: boolean;
    skipProcessing: boolean;
  }) => Promise<CameraShot | undefined>,
): CameraCapturePort {
  return {
    async takePicture(): Promise<CameraShot> {
      const shot = await takePictureAsync({
        quality: CAPTURE_QUALITY,
        exif: false,
        base64: false,
        skipProcessing: false,
      });
      if (shot === undefined) throw new Error('takePictureAsync returned no picture');
      return { uri: shot.uri, width: shot.width, height: shot.height };
    },
  };
}
