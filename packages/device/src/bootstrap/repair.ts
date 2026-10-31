/**
 * The production construction site for the repair screens, the twin of `notes.ts`: it resolves the
 * shared runtime pieces for the signed-in user and hands them to `createRepairRuntime`.
 *
 * Node-safe like `notes.ts`: the camera, signature pad and thumbnail loader are injected because
 * they bind native modules.
 */
import type { CommandIdentity } from '@bolusi/core';
import type { ClientDatabase } from '@bolusi/db-client';
import type { QrisPort } from '@bolusi/modules/money';
import { REPAIR_TICKET_ENTITY, catalogModelSearch, tn } from '@bolusi/modules/repair';
import type { RepairRuntime } from '@bolusi/modules/repair/screens';
import type { PhotoCapture } from '@bolusi/modules/screen-kit';
import type { Kysely } from 'kysely';

import type { MediaClient } from '../media/client.js';
import type { GalleryPort } from '../media/import.js';
import { createPhotoSharer, type SharePlatform } from '../media/share.js';
import { createInventoryRuntime } from '../models/inventory/runtime-adapter.js';
import { createPurchasingRuntime } from '../models/purchasing/runtime-adapter.js';
import { createRepairRuntime, type RepairMediaSeams } from '../models/repair/runtime-adapter.js';

import type { Bootstrapped } from './bootstrap.js';
import { notesMediaSeamsFor } from './notes.js';
import { createRepairPrinting, type PrintPlatform } from './repair-printing.js';
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
  capture: Pick<
    RepairMediaSeams,
    'capturePhoto' | 'captureSignature' | 'loadModelPhoto' | 'recordVideo' | 'playVideo'
  >,
  share?: SharePlatform,
  pickPhoto?: PhotoCapture,
): RepairMediaSeams {
  const loadThumbnail = notesMediaSeamsFor(media).loadThumbnail;
  return {
    ...capture,
    loadThumbnail,
    videoKept: (ref) => (media === null ? Promise.resolve(false) : media.hasLocal(ref.mediaId)),
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
  /** The camera's code scanner for the items screens; absent ⇒ they offer no scan. */
  readonly scanCode?: (() => Promise<string | null>) | undefined;
  /** QRIS through Xendit for a user (`qris-transport.ts`); absent ⇒ QRIS is only taken by hand. */
  readonly qris?: ((userId: string) => QrisPort) | undefined;
  /** The server this device syncs with, which serves customers' status pages. */
  readonly statusSite?: string | null;
}): RepairRuntime {
  const { app, identity } = deps;
  const printing =
    deps.print === undefined
      ? undefined
      : createRepairPrinting({
          db: app.db.db,
          loadThumbnail: deps.media.loadThumbnail,
          platform: deps.print,
        });
  const runtime = deps.runtime.moduleRuntimeFor({
    tenantId: identity.tenantId,
    storeId: identity.storeId,
    deviceId: identity.deviceId,
  });
  // The parts a servisan draws on, and the parts list the shell opens from the account menu. Its
  // "fits" picker searches repair's phone catalog, bound once the repair runtime exists.
  let repair: RepairRuntime | null = null;
  const inventory = createInventoryRuntime({
    runtime,
    invalidation: app.invalidation,
    identity,
    searchModels: (text, limit) => catalogModelSearch(repair!)(text, limit),
    scanCode: deps.scanCode,
  });
  // Orders to suppliers ("Belanja"), signed with the name the slips print.
  const purchasing = createPurchasingRuntime({
    runtime,
    invalidation: app.invalidation,
    identity,
    storeName: async () =>
      (await repair!.query('printSettings', {})).rows[0]?.name ??
      (await printing?.storeName()) ??
      null,
  });
  repair = createRepairRuntime({
    runtime,
    db: app.db.db,
    invalidation: app.invalidation,
    identity,
    media: deps.media,
    printing,
    inventory,
    purchasing,
    qris: deps.qris?.(identity.userId),
    statusSite: deps.statusSite ?? null,
  });
  return repair;
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
