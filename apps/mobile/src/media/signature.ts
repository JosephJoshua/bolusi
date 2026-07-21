// Signature capture — 06-media-pipeline §2.3.
//
// §2.3's whole spec is four rows plus one sentence: PNG, max 800 x 400, white background / black
// stroke, expected < 64 KiB, and "Metadata, hashing, queueing | identical to §2.2 steps 2, 5–8".
// This file is that sentence made literal. The raster/encoder half lives in `signature-png.ts`
// (pure); everything below is the SAME tail `capture.ts` runs for a photo — fix, move, hash, size,
// row, trigger — over different bytes and a different mime.
//
// WHY THE TAIL IS NOT SHARED AS ONE FUNCTION WITH `capturePhoto`, having considered it: the two
// heads differ in every effect (a camera and a compressor vs. a rasteriser and a byte write) and
// the tail differs in `type`/`mime`/extension. Factoring it would produce a function whose
// parameter list IS the difference, plus two callers that each read worse than the eight numbered
// steps they implement. The duplication is six statements of straight-line code against a spec
// section that pins their order; the risk §2.8 guards (two divergent IMPLEMENTATIONS of one rule)
// is carried by `insertMediaItem`, `moveCaptureToDocumentDir` and `MediaFilePort`, which ARE shared.
import {
  isCaptureRefused,
  type ClockPort,
  type IdSource,
  type LocationPort,
  type MediaFilePort,
} from '@bolusi/core';
import type { MediaRef } from '@bolusi/schemas';
import type { Kysely } from 'kysely';

import type { CaptureIdentity } from './capture.js';
import { insertMediaItem } from './queue.js';
import { hasInk, renderSignaturePng, type PadSize, type SignatureStroke } from './signature-png.js';

const SIGNATURE_EXTENSION = 'png';

export interface SignatureCaptureDeps<DB> {
  readonly db: Kysely<DB>;
  readonly identity: CaptureIdentity;
  readonly files: MediaFilePort;
  /** `writeCaptureToCache` (files.ts) — synchronous by contract; see its header. */
  readonly writeToCache: (bytes: Uint8Array, mediaId: string, extension: string) => string;
  /** `moveCaptureToDocumentDir` (files.ts). */
  readonly moveToDocuments: (
    cacheUri: string,
    mediaId: string,
    extension: string,
  ) => Promise<string>;
  readonly location: LocationPort;
  readonly clock: ClockPort;
  readonly newId: IdSource;
  readonly freeSpaceBytes: () => number;
  /** 06 §5.2 (b), fired after the row commits. */
  readonly onCaptured: () => void;
}

/**
 * `refused_empty` exists because an unsigned pad must not become a signature.
 *
 * A blank 800 x 400 white PNG is a perfectly valid file that hashes, uploads, and renders — and
 * would sit in a repair record as a customer's acknowledgement of work they never acknowledged.
 * The one thing that distinguishes it from evidence is whether anyone touched the pad, and the only
 * place that is knowable is here, before the bytes exist.
 */
export type SignatureOutcome =
  | { readonly kind: 'captured'; readonly ref: MediaRef; readonly localPath: string }
  | { readonly kind: 'refused_low_storage'; readonly freeBytes: number }
  | { readonly kind: 'refused_empty' };

/** 06 §2.3 — render, then §2.2 steps 2, 5–8 verbatim. */
export async function captureSignature<DB>(
  deps: SignatureCaptureDeps<DB>,
  strokes: readonly SignatureStroke[],
  pad: PadSize,
): Promise<SignatureOutcome> {
  if (!hasInk(strokes)) return { kind: 'refused_empty' };

  // §7's band check, before any bytes are written — the same rule the camera obeys.
  const freeBytes = deps.freeSpaceBytes();
  if (isCaptureRefused(freeBytes)) return { kind: 'refused_low_storage', freeBytes };

  // Step 2 — the fix, never blocking.
  const capturedAt = deps.clock.now();
  const location = deps.location.getBestFix();

  const mediaId = deps.newId();
  const png = renderSignaturePng(strokes, pad);

  // Step 5 — the cache→document move, awaited, before anything references the file.
  const cacheUri = deps.writeToCache(png, mediaId, SIGNATURE_EXTENSION);
  const localPath = await deps.moveToDocuments(cacheUri, mediaId, SIGNATURE_EXTENSION);

  // Step 6 — hash and size the file AT ITS FINAL PATH. `png.length` is deliberately not used for
  // `sizeBytes`: it is what we intended to write, and the row must record what is on disk. If the
  // write short-changed the file, the signed `mediaRef` has to say so at capture rather than let
  // the server discover it at `complete` and report HASH_MISMATCH as "your evidence rotted".
  const sha256 = await deps.files.hashFile(localPath);
  const sizeBytes = await deps.files.sizeOf(localPath);

  // Step 7 — the row.
  await insertMediaItem(deps.db, {
    id: mediaId,
    tenantId: deps.identity.tenantId,
    storeId: deps.identity.storeId,
    userId: deps.identity.userId,
    deviceId: deps.identity.deviceId,
    type: 'signature',
    mime: 'image/png',
    sizeBytes,
    sha256,
    capturedAt,
    location,
    localPath,
  });

  deps.onCaptured();

  // Step 8 — the ref.
  return {
    kind: 'captured',
    localPath,
    ref: {
      mediaId,
      sha256,
      mime: 'image/png',
      type: 'signature',
      sizeBytes,
      capturedAt,
      location,
      userId: deps.identity.userId,
      deviceId: deps.identity.deviceId,
    },
  };
}
