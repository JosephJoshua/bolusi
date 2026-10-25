/**
 * The production construction site for the repair screens, the twin of `notes.ts`: it resolves the
 * shared runtime pieces for the signed-in user and hands them to `createRepairRuntime`.
 *
 * Node-safe like `notes.ts`: the camera, signature pad and thumbnail loader are injected because
 * they bind native modules.
 */
import type { CommandIdentity } from '@bolusi/core';
import type { RepairRuntime } from '@bolusi/modules/repair/screens';

import type { MediaClient } from '../media/client.js';
import { createRepairRuntime, type RepairMediaSeams } from '../screens/repair/runtime-adapter.js';

import type { Bootstrapped } from './bootstrap.js';
import { notesMediaSeamsFor } from './notes.js';
import type { AppRuntime } from './runtime.js';

export type { RepairMediaSeams };

/**
 * The media seams for repair: the capture and signature hosts as given, and the same thumbnail
 * decision notes makes (a device with no media client shows every photo as not yet available).
 */
export function repairMediaSeamsFor(
  media: MediaClient | null,
  capture: Pick<RepairMediaSeams, 'capturePhoto' | 'captureSignature'>,
): RepairMediaSeams {
  return { ...capture, loadThumbnail: notesMediaSeamsFor(media).loadThumbnail };
}

export function createSessionRepairRuntime(deps: {
  readonly app: Bootstrapped;
  readonly runtime: AppRuntime;
  readonly identity: CommandIdentity;
  readonly media: RepairMediaSeams;
}): RepairRuntime {
  const { app, identity } = deps;
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
  });
}
