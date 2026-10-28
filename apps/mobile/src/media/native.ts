// THE NATIVE BINDING SITE for the media pipeline (08 §3.2; testing-guide §2.3).
//
// Everything here imports a native module — `expo-file-system`, `expo-image-manipulator` (and the
// shared background-task binding in ports/background-task.ts) — which is exactly why it is a separate file that
// only `index.ts` imports. `client.ts` and every module it reaches name only INTERFACES, so the
// whole media client runs under Node in the test lane while this five-function file is the only
// thing that cannot. Same split, same reason, as `index.ts`'s op-sqlite/NetInfo binding.
//
// NOTHING HERE IS DEVICE-VERIFIED. There is no Android device and no iOS device on this
// infrastructure (D12/D13), so every line is type-checked against the installed SDK 57
// declarations and unexecuted. That is a statement about this file specifically — the pipeline's
// decisions (the two compression passes, the capture ordering, the drain triggers, the pruning
// rules, the background-registration outcome) all live behind these seams and DO run in the lane.
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import type { BackgroundHost } from '@bolusi/device/bootstrap/background-task';
import { expoBackgroundTaskPlatform } from '../ports/background-task.js';
import type { CompressedImage, ImageCompressorPort } from '@bolusi/device/media/compression';
import { availableDiskSpaceBytes, createEncryptingMediaFileParts } from './files.js';
import {
  createMediaClient,
  type MediaClient,
  type MediaClientDeps,
} from '@bolusi/device/media/client';

/**
 * The `expo-image-manipulator` binding — SDK 57's CONTEXTUAL API.
 *
 * `manipulateAsync` is `@deprecated` in 57.0.2 (build/ImageManipulator.d.ts:16, "replaced by the
 * new, contextual and object-oriented API"), so this uses `manipulate(uri)` →
 * `ImageManipulatorContext` → `renderAsync()` → `ImageRef.saveAsync({ compress, format })`, read
 * from the installed declarations rather than from memory.
 */
export const expoImageCompressor: ImageCompressorPort = {
  async compress(uri, target, compress): Promise<CompressedImage> {
    const context = ImageManipulator.manipulate(uri);
    // `resize` mutates-and-returns the same context (it is chainable), so the return value is
    // discarded deliberately rather than reassigned — both spellings are the same object.
    if (target !== null) context.resize(target);
    const image = await context.renderAsync();
    const saved = await image.saveAsync({ compress, format: SaveFormat.JPEG });
    // `saved.width`/`saved.height` are the ENCODER's numbers. Returning `target`'s instead would
    // make every downstream dimension assertion a tautology about our own request. `sizeBytes` is the
    // encoded PLAINTEXT file's length, measured here (task 158) — NOT via the encrypting `sizeOf`.
    return {
      uri: saved.uri,
      width: saved.width,
      height: saved.height,
      sizeBytes: new File(saved.uri).size,
    };
  },
};

/** The deps the composition root still has to supply — the ones that are not expo modules. */
export type MediaClientForAppConfig = Omit<
  MediaClientDeps,
  | 'files'
  | 'compressor'
  | 'freeSpaceBytes'
  | 'moveToDocuments'
  | 'writeToCache'
  | 'findCached'
  | 'writeCached'
  | 'evictCached'
  | 'listRemoteCache'
  | 'toRenderUri'
  | 'clearRenderTemps'
  | 'background'
> & {
  /**
   * Trigger (d): the module-scope host to register with (index.ts), or `null` for a client built for
   * one headless pass, which the host drives directly. Required, so leaving it out is not an option.
   */
  readonly background: { readonly host: BackgroundHost } | null;
  /**
   * Reads the 32-byte SecureStore DB key as hex (task 158). The media-file cipher derives a sibling
   * key from it; `null` (never post-boot) fails media file ops closed rather than writing plaintext.
   */
  readonly dbKeyHex: () => Promise<string | null>;
};

/**
 * Build the real media client: the expo bindings above, plus the caller's DB/transport/ports.
 *
 * The filesystem port and the two directory helpers are bound HERE rather than defaulted inside
 * `client.ts`, so `client.ts` has no expo import and no expo-shaped default that a test would have
 * to override. A default that reaches for a native module is how a "pure" module quietly stops
 * being importable under Node.
 */
export function createMediaClientForApp(config: MediaClientForAppConfig): MediaClient {
  const { background, dbKeyHex, ...rest } = config;
  // The encrypting file parts (task 158): one cipher, lazily keyed from the DB key, behind every
  // media file read/write. `client.ts` still names only interfaces — the expo + crypto binding is here.
  const parts = createEncryptingMediaFileParts(dbKeyHex);
  return createMediaClient({
    ...rest,
    files: parts.port,
    compressor: expoImageCompressor,
    freeSpaceBytes: availableDiskSpaceBytes,
    moveToDocuments: parts.moveToDocuments,
    writeToCache: parts.writeToCache,
    findCached: parts.findCached,
    writeCached: parts.writeCached,
    evictCached: parts.evictCached,
    listRemoteCache: parts.listRemoteCache,
    toRenderUri: parts.toRenderUri,
    clearRenderTemps: parts.clearRenderTemps,
    background:
      background === null ? null : { platform: expoBackgroundTaskPlatform, host: background.host },
  });
}
