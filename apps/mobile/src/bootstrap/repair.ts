/**
 * The production construction site for the repair screens, the twin of `notes.ts`: it resolves the
 * shared runtime pieces for the signed-in user and hands them to `createRepairRuntime`.
 *
 * Node-safe like `notes.ts`: the camera, signature pad and thumbnail loader are injected because
 * they bind native modules.
 */
import type { CommandIdentity } from '@bolusi/core';
import type { ClientDatabase } from '@bolusi/db-client';
import { REPAIR_TICKET_ENTITY } from '@bolusi/modules/repair';
import { tn, type RepairRuntime } from '@bolusi/modules/repair/screens';
import type { Kysely } from 'kysely';

import type { MediaClient } from '../media/client.js';
import { createPhotoSharer, type SharePlatform } from '../media/share.js';
import { createRepairRuntime, type RepairMediaSeams } from '../screens/repair/runtime-adapter.js';

import type { Bootstrapped } from './bootstrap.js';
import { notesMediaSeamsFor } from './notes.js';
import type { AppRuntime } from './runtime.js';
import type { RejectedSubjectReaders } from './sync-status-reads.js';

export type { RepairMediaSeams };

/**
 * The media seams for repair: the capture and signature hosts and the model photo loader as given,
 * and the same thumbnail decision notes makes (a device with no media client shows every photo as not yet available).
 * Sharing is offered only with a media client and a share platform: without either there is no
 * verified file to hand over.
 */
export function repairMediaSeamsFor(
  media: MediaClient | null,
  capture: Pick<RepairMediaSeams, 'capturePhoto' | 'captureSignature' | 'loadModelPhoto'>,
  share?: SharePlatform,
): RepairMediaSeams {
  const loadThumbnail = notesMediaSeamsFor(media).loadThumbnail;
  return {
    ...capture,
    loadThumbnail,
    ...(media === null || share === undefined
      ? {}
      : { sharePhoto: createPhotoSharer(loadThumbnail, share) }),
  };
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

/**
 * Names the servisan a refused change was about, for the sync problems list: "Servisan K7Q-0042".
 * A ticket the refusal removed (its intake was refused) has no row left and stays unnamed.
 */
export const REPAIR_REJECTED_SUBJECTS: RejectedSubjectReaders = {
  [REPAIR_TICKET_ENTITY]: async (db: Kysely<ClientDatabase>, ids: readonly string[]) => {
    const rows = await db
      .selectFrom('repairTickets')
      .select(['id', 'ticketNumber'])
      .where('id', 'in', ids)
      .execute();
    const subjects = new Map<string, string>();
    for (const row of rows) {
      // A PK is never null in practice; the generated type says it can be.
      if (row.id !== null) {
        subjects.set(row.id, tn('repair.ticket.numbered', { number: row.ticketNumber }));
      }
    }
    return subjects;
  },
};
