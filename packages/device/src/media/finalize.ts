// The shared capture-finalization tail (06-media-pipeline §2.2 steps 5–8) — extracted from
// `capturePhoto` and `captureSignature`, which ran a byte-for-byte identical pipeline once the source
// bytes existed (task 185 leg 2). Only the source URI, file extension, media type and MIME differ; the
// move → hash → size → row → onCaptured → signed-ref sequence is the same, and it is the sequence that
// binds the evidence: `sha256`/`sizeBytes` are MEASURED off the final file (not the compressor's or
// renderer's own report), because the op signature covers the `mediaRef` and it must describe the
// bytes actually on disk — a move that silently did nothing surfaces here as a hashFile/sizeOf reject
// rather than as an empty-string SHA-256 the drain would later call `HASH_MISMATCH` ("your evidence
// rotted"). One home means a fix to that ordering reaches both capture paths.
import type { MediaFilePort } from '@bolusi/core';
import type { MediaRef } from '@bolusi/schemas';
import type { Kysely } from 'kysely';

import type { CaptureIdentity } from './capture.js';
import { insertMediaItem } from './queue.js';

/** The ports steps 5–8 need. A structural subset of both `CaptureDeps` and `SignatureCaptureDeps`. */
export interface FinalizeMediaDeps<DB> {
  readonly db: Kysely<DB>;
  readonly identity: CaptureIdentity;
  readonly files: MediaFilePort;
  /** `moveCaptureToDocumentDir` (files.ts) — injected so the ordering is assertable under Node. */
  readonly moveToDocuments: (
    cacheUri: string,
    mediaId: string,
    extension: string,
  ) => Promise<string>;
  /** 06 §5.2 (b): fired AFTER the row commits — a trigger before the INSERT drains without its item. */
  readonly onCaptured: () => void;
}

/** What varies between a photo and a signature: the produced bytes' location and identity. */
export interface FinalizeMediaInput {
  /** The cache URI the produced bytes already live at (a compressed photo, or a written PNG). */
  readonly sourceUri: string;
  readonly mediaId: string;
  readonly extension: string;
  readonly type: MediaRef['type'];
  readonly mime: MediaRef['mime'];
  readonly capturedAt: number;
  readonly location: MediaRef['location'];
}

export interface FinalizedMedia {
  readonly localPath: string;
  /** The signed ref the command embeds (06 §4). Carries the MEASURED `sha256`/`sizeBytes`. */
  readonly ref: MediaRef;
}

export async function finalizeMediaCapture<DB>(
  deps: FinalizeMediaDeps<DB>,
  input: FinalizeMediaInput,
): Promise<FinalizedMedia> {
  // Step 5 — cache → document dir, AWAITED, before anything references the file.
  const localPath = await deps.moveToDocuments(input.sourceUri, input.mediaId, input.extension);

  // Step 6 — hash + size the FINAL bytes at their FINAL path. Both reads reject on a missing file, so
  // a move that silently did nothing surfaces here rather than as an empty-string hash downstream.
  const sha256 = await deps.files.hashFile(localPath);
  const sizeBytes = await deps.files.sizeOf(localPath);

  // Step 7 — the row.
  await insertMediaItem(deps.db, {
    id: input.mediaId,
    tenantId: deps.identity.tenantId,
    storeId: deps.identity.storeId,
    userId: deps.identity.userId,
    deviceId: deps.identity.deviceId,
    type: input.type,
    mime: input.mime,
    sizeBytes,
    sha256,
    capturedAt: input.capturedAt,
    location: input.location,
    localPath,
  });

  // 06 §5.2 (b). After the commit, so the pass it schedules can see the row.
  deps.onCaptured();

  // Step 8 — the ref the command embeds. `sizeBytes`/`sha256` are the MEASURED values, not the
  // producer's report: the op signature covers them, and they must describe the bytes on disk.
  return {
    localPath,
    ref: {
      mediaId: input.mediaId,
      sha256,
      mime: input.mime,
      type: input.type,
      sizeBytes,
      capturedAt: input.capturedAt,
      location: input.location,
      userId: deps.identity.userId,
      deviceId: deps.identity.deviceId,
    },
  };
}
