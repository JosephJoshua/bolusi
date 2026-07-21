// THE NATIVE BINDING SITE for the media pipeline (08 §3.2; testing-guide §2.3).
//
// Everything here imports a native module — `expo-file-system`, `expo-image-manipulator`,
// `expo-background-task`, `expo-task-manager` — which is exactly why it is a separate file that
// only `index.ts` imports. `client.ts` and every module it reaches name only INTERFACES, so the
// whole media client runs under Node in the test lane while this five-function file is the only
// thing that cannot. Same split, same reason, as `index.ts`'s op-sqlite/NetInfo binding.
//
// NOTHING HERE IS DEVICE-VERIFIED. There is no Android device and no iOS device on this
// infrastructure (D12/D13), so every line is type-checked against the installed SDK 57
// declarations and unexecuted. That is a statement about this file specifically — the pipeline's
// decisions (the two compression passes, the capture ordering, the drain triggers, the pruning
// rules, the background-registration outcome) all live behind these seams and DO run in the lane.
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import type { BackgroundTaskPlatform } from './background-task.js';
import type { CompressedImage, ImageCompressorPort } from './compression.js';
import {
  availableDiskSpaceBytes,
  expoMediaFilePort,
  moveCaptureToDocumentDir,
  remoteMediaCache,
  writeCaptureToCache,
} from './files.js';
import { createMediaClient, type MediaClient, type MediaClientDeps } from './client.js';

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
    // make every downstream dimension assertion a tautology about our own request.
    return { uri: saved.uri, width: saved.width, height: saved.height };
  },
};

/**
 * The `expo-background-task` + `expo-task-manager` binding.
 *
 * `defineTask`'s executor is typed `(body) => Promise<any>` upstream; ours takes no body and the
 * wrapper discards it. The `void` return is deliberate: `BackgroundTaskResult` exists (Success = 1,
 * Failed = 2) and returning `Failed` would be the honest thing IF a bounded drain pass could fail —
 * it cannot, by design. The drain loop never throws to its caller (drain.ts); a pass that uploads
 * nothing because the network is down is a NORMAL pass, and reporting `Failed` for it would teach
 * WorkManager to back this task off for a condition that is not an error. So the executor resolves
 * either way and the real failure reporting stays where 06 §8 puts it: `media_items.last_error_code`
 * and the surfacing port.
 */
export const expoBackgroundTaskPlatform: BackgroundTaskPlatform = {
  defineTask(name, executor) {
    // Guarded because `defineTask` is a PROCESS-GLOBAL registration and this function is reachable
    // from any composition. Defining twice is not idempotent upstream — it replaces the executor —
    // and a second definition racing the first is the collision `bootstrap/triggers.ts` names when
    // it explains why trigger (d) was left to this task rather than built in two places.
    if (TaskManager.isTaskDefined(name)) return;
    TaskManager.defineTask(name, async () => {
      await executor();
    });
  },
  getStatusAsync: () => BackgroundTask.getStatusAsync(),
  registerTaskAsync: (name, options) => BackgroundTask.registerTaskAsync(name, options),
  isTaskRegisteredAsync: (name) => TaskManager.isTaskRegisteredAsync(name),
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
  | 'background'
> & {
  /** Pass `false` to compose without trigger (d) — an explicit choice, never a silent absence. */
  readonly registerBackgroundTask?: boolean;
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
  const { registerBackgroundTask = true, ...rest } = config;
  return createMediaClient({
    ...rest,
    files: expoMediaFilePort,
    compressor: expoImageCompressor,
    freeSpaceBytes: availableDiskSpaceBytes,
    moveToDocuments: moveCaptureToDocumentDir,
    writeToCache: writeCaptureToCache,
    findCached: (mediaId, extension) => remoteMediaCache.find(mediaId, extension),
    writeCached: (mediaId, extension, bytes) => remoteMediaCache.write(mediaId, extension, bytes),
    evictCached: (mediaId) => remoteMediaCache.evict(mediaId),
    listRemoteCache: () => remoteMediaCache.list(),
    background: registerBackgroundTask ? expoBackgroundTaskPlatform : null,
  });
}
