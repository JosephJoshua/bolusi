/**
 * The production construction site for the repair screens, the twin of `notes.ts`: it resolves the
 * shared runtime pieces for the signed-in user and hands them to `createRepairRuntime`.
 *
 * Node-safe like `notes.ts`: the camera, signature pad and thumbnail loader are injected because
 * they bind native modules.
 */
import type { CommandIdentity } from '@bolusi/core';
import type { RepairRuntime } from '@bolusi/modules/repair/screens';
import type { PhotoCapture } from '@bolusi/modules/screen-kit';

import type { MediaClient } from '../media/client.js';
import type { GalleryPort } from '../media/import.js';
import { createPhotoSharer, type SharePlatform } from '../media/share.js';
import { createRepairRuntime, type RepairMediaSeams } from '../screens/repair/runtime-adapter.js';

import type { Bootstrapped } from './bootstrap.js';
import { notesMediaSeamsFor } from './notes.js';
import { createRepairPrinting, type PrintPlatform } from './repair-printing.js';
import type { AppRuntime } from './runtime.js';

export type { RepairMediaSeams };

/**
 * The media seams for repair: the capture and signature hosts as given, and the same thumbnail
 * decision notes makes (a device with no media client shows every photo as not yet available).
 * Sharing is offered only with a media client and a share platform: without either there is no
 * verified file to hand over.
 */
export function repairMediaSeamsFor(
  media: MediaClient | null,
  capture: Pick<RepairMediaSeams, 'capturePhoto' | 'captureSignature'>,
  share?: SharePlatform,
  pickPhoto?: PhotoCapture,
): RepairMediaSeams {
  const loadThumbnail = notesMediaSeamsFor(media).loadThumbnail;
  return {
    ...capture,
    loadThumbnail,
    ...(pickPhoto === undefined ? {} : { pickPhoto }),
    ...(media === null || share === undefined
      ? {}
      : { sharePhoto: createPhotoSharer(loadThumbnail, share) }),
  };
}

/**
 * Pick a picture from the gallery (the store logo) into the media pipeline, signed by the session
 * user. Absent without a media client or a gallery, and the settings screen offers no picker.
 */
export function galleryPickerFor(
  media: MediaClient | null,
  identity: CommandIdentity,
  gallery: GalleryPort | undefined,
): PhotoCapture | undefined {
  if (media === null || gallery === undefined) return undefined;
  return async () => {
    const picked = await gallery.pick();
    if (picked === null) return null;
    const outcome = await media.importImage(identity, picked);
    if (outcome.kind === 'refused_low_storage') throw new Error('storage is nearly full');
    return { mediaRef: outcome.ref };
  };
}

export function createSessionRepairRuntime(deps: {
  readonly app: Bootstrapped;
  readonly runtime: AppRuntime;
  readonly identity: CommandIdentity;
  readonly media: RepairMediaSeams;
  /** Absent ⇒ this build cannot print and the screens show no print action. */
  readonly print?: PrintPlatform | undefined;
}): RepairRuntime {
  const { app, identity } = deps;
  const printing =
    deps.print === undefined
      ? undefined
      : createRepairPrinting({
          db: app.db.db,
          userId: identity.userId,
          loadThumbnail: deps.media.loadThumbnail,
          platform: deps.print,
        });
  return createRepairRuntime({
    runtime: deps.runtime.moduleRuntimeFor({
      tenantId: identity.tenantId,
      storeId: identity.storeId,
      deviceId: identity.deviceId,
    }),
    db: app.db.db,
    invalidation: app.invalidation,
    identity,
    media: deps.media,
    printing,
  });
}
