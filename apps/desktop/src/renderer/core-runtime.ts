// The repair screens' runtime on the PC: every read and write goes to the offline core, named for
// the person this runtime was built for (the core refuses it for anyone else). Permissions come
// from the core's state, so a change in someone's grants builds a new runtime and the screens
// re-derive what they show. Photos and signatures are taken in the window and handed to the core.
import { createUuidV7Generator } from '@bolusi/core';
import type { RepairPrinting, RepairRuntime } from '@bolusi/modules/repair/desktop';
import type { CapturedMedia, CaptureRequest } from '@bolusi/modules/screen-kit';

import type { CoreCaptureOutcome, SessionView } from '../core/api.js';
import { CORE_EVENTS } from '../core/api.js';
import type { Client } from '../main/rpc.js';

import { compressPhoto, pickPhotoFile, type PcCapture } from './capture.js';
import { desktopPrinting } from './print.js';

// The ids a form takes up front (a new ticket's) are UUIDv7 like every other id; the window mints
// its own so `newId()` stays synchronous, as the screens call it.
const newId = createUuidV7Generator({
  now: () => Date.now(),
  randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
});

class CaptureRefused extends Error {
  constructor(readonly outcome: Exclude<CoreCaptureOutcome['kind'], 'captured'>) {
    super(`capture refused: ${outcome}`);
    this.name = 'CaptureRefused';
  }
}

function captured(outcome: CoreCaptureOutcome): CapturedMedia {
  if (outcome.kind !== 'captured') throw new CaptureRefused(outcome.kind);
  return { mediaRef: outcome.mediaRef };
}

export function createCoreRepairRuntime(deps: {
  readonly client: Client;
  readonly session: Pick<SessionView, 'permissions' | 'colleaguePermissions'>;
  readonly userId: string;
  readonly storeName: string;
  readonly capture: PcCapture;
}): RepairRuntime {
  const { client, userId, capture } = deps;
  const granted = new Set(deps.session.permissions);
  const call = <T>(method: string, ...args: readonly unknown[]): Promise<T> =>
    client.call<T>(method, userId, ...args);

  const printing: RepairPrinting = desktopPrinting(
    {
      storeName: () => call('repair.print.storeName'),
      userName: () => call('repair.print.userName'),
      readPaper: () => call('repair.print.readPaper'),
      writePaper: (paper) => call('repair.print.writePaper', paper),
      // Replaced by the PC's printers below; the window prints, never the core.
      output: () => Promise.resolve('cancelled'),
      imageDataUri: (ref) => call('repair.print.imageDataUri', ref),
    },
    deps.storeName,
  );

  const runtime: RepairRuntime = {
    userId,
    query: ((name: string, input: unknown) =>
      call('repair.query', name, input)) as RepairRuntime['query'],
    run: ((name: string, input: unknown) =>
      call('repair.run', name, input)) as RepairRuntime['run'],
    hasPermission: (permission) => granted.has(permission),
    colleagueHasPermission: (colleague, permission) =>
      deps.session.colleaguePermissions[colleague]?.includes(permission) ?? false,
    newId,
    subscribe: (listener) => client.on(CORE_EVENTS.repairChanged, listener),
    ticketSyncStatuses: (ticketIds) => call('repair.ticketSyncStatuses', ticketIds),
    technicians: () => call('repair.technicians'),
    loadThumbnail: (ref) => call('repair.loadThumbnail', ref),
    loadModelPhoto: (photo) => call('repair.loadModelPhoto', photo),
    async capturePhoto(request?: CaptureRequest) {
      const photo = await capture.photo(request);
      if (photo === null) return null;
      return captured(await call('media.importImage', await compressPhoto(photo)));
    },
    // A picture from this PC's files, such as the store's logo.
    async pickPhoto() {
      const photo = await pickPhotoFile();
      if (photo === null) return null;
      return captured(await call('media.importImage', await compressPhoto(photo)));
    },
    async captureSignature(request?: CaptureRequest) {
      const signature = await capture.signature(request);
      if (signature === null) return null;
      return captured(await call('media.captureSignature', signature.strokes, signature.pad));
    },
    printing,
  };
  return runtime;
}
