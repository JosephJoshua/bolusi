// The repair screens' runtime on the PC: every read and write goes to the offline core, named for
// the person this runtime was built for (the core refuses it for anyone else). Permissions come
// from the core's state, so a change in someone's grants builds a new runtime and the screens
// re-derive what they show. Photos, signatures and the ownership video are taken in the window and
// handed to the core.
import { createUuidV7Generator } from '@bolusi/core';
import { consoleDiagnostics } from '@bolusi/device/ports/diagnostics';
import type { InventoryRuntime } from '@bolusi/modules/inventory/desktop';
import { catalogModelSearch } from '@bolusi/modules/repair';
import type { RepairPrinting, RepairRuntime } from '@bolusi/modules/repair/desktop';
import type { CapturedMedia, CaptureRequest } from '@bolusi/modules/screen-kit';

import type {
  CoreCaptureOutcome,
  CoreVideoLoad,
  CoreVideoOutcome,
  SessionView,
} from '../core/api.js';
import { CORE_EVENTS } from '../core/api.js';
import type { Client } from '../main/rpc.js';

import { compressPhoto, pickPhotoFile, playableVideo, type PcCapture } from './capture.js';
import { desktopPrinting } from './print.js';

// The ids a form takes up front (a new ticket's) are UUIDv7 like every other id; the window mints
// its own so `newId()` stays synchronous, as the screens call it.
const newId = createUuidV7Generator({
  now: () => Date.now(),
  randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
});

class CaptureRefused extends Error {
  constructor(
    readonly outcome:
      | Exclude<CoreCaptureOutcome['kind'], 'captured'>
      | Exclude<CoreVideoOutcome['kind'], 'captured'>,
  ) {
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
  readonly session: Pick<SessionView, 'permissions' | 'colleaguePermissions' | 'limits'>;
  readonly userId: string;
  readonly storeName: string;
  readonly capture: PcCapture;
  readonly statusSite: string;
}): RepairRuntime {
  const { client, userId, capture } = deps;
  const granted = new Set(deps.session.permissions);
  const limitOf = (permission: string): number | null =>
    granted.has(permission) ? (deps.session.limits[permission] ?? null) : 0;
  const call = <T>(method: string, ...args: readonly unknown[]): Promise<T> =>
    client.call<T>(method, userId, ...args);

  const printing: RepairPrinting = desktopPrinting(
    {
      storeName: () => call('repair.print.storeName'),
      readPaper: () => call('repair.print.readPaper'),
      writePaper: (paper) => call('repair.print.writePaper', paper),
      // Replaced by the PC's printers below; the window prints, never the core.
      output: () => Promise.resolve('cancelled'),
      imageDataUri: (ref) => call('repair.print.imageDataUri', ref),
    },
    deps.storeName,
  );

  const query = ((name: string, input: unknown) =>
    call('repair.query', name, input)) as RepairRuntime['query'];
  // The parts list and each servisan's parts: the same person, permissions and change feed. Its
  // "fits" picker searches the phone catalog the intake uses. No camera scan: a USB scanner types.
  const inventory: InventoryRuntime = {
    userId,
    query: ((name: string, input: unknown) =>
      call('inventory.query', name, input)) as InventoryRuntime['query'],
    run: ((name: string, input: unknown) =>
      call('inventory.run', name, input)) as InventoryRuntime['run'],
    hasPermission: (permission) => granted.has(permission),
    colleagueHasPermission: (colleague, permission) =>
      deps.session.colleaguePermissions[colleague]?.includes(permission) ?? false,
    limitOf,
    newId,
    subscribe: (listener) => client.on(CORE_EVENTS.repairChanged, listener),
    searchModels: catalogModelSearch({ query }),
  };

  const runtime: RepairRuntime = {
    userId,
    query,
    run: ((name: string, input: unknown) =>
      call('repair.run', name, input)) as RepairRuntime['run'],
    hasPermission: (permission) => granted.has(permission),
    colleagueHasPermission: (colleague, permission) =>
      deps.session.colleaguePermissions[colleague]?.includes(permission) ?? false,
    limitOf,
    newId,
    // The ledger's port: the same person, permissions and change feed as the repair screens.
    money: {
      userId,
      query: ((name: string, input: unknown) =>
        call('money.query', name, input)) as RepairRuntime['money']['query'],
      run: ((name: string, input: unknown) =>
        call('money.run', name, input)) as RepairRuntime['money']['run'],
      hasPermission: (permission) => granted.has(permission),
      colleagueHasPermission: (colleague, permission) =>
        deps.session.colleaguePermissions[colleague]?.includes(permission) ?? false,
      limitOf,
      newId,
      stores: () => call('money.stores'),
      // QRIS through Xendit, made by the core like the staff calls; errors come back as QrisError.
      qris: {
        connections: () => call('money.qris.connections'),
        connect: (accountId, secretKey) => call('money.qris.connect', accountId, secretKey),
        disconnect: (accountId) => call('money.qris.disconnect', accountId),
        createCharge: (body) => call('money.qris.createCharge', body),
        charge: (id) => call('money.qris.charge', id),
        simulate: (id) => call('money.qris.simulate', id),
      },
    },
    approvals: {
      userId,
      query: ((name: string, input: unknown) =>
        call('approvals.query', name, input)) as RepairRuntime['approvals']['query'],
      run: ((name: string, input: unknown) =>
        call('approvals.run', name, input)) as RepairRuntime['approvals']['run'],
      hasPermission: (permission) => granted.has(permission),
      colleagueHasPermission: (colleague, permission) =>
        deps.session.colleaguePermissions[colleague]?.includes(permission) ?? false,
      limitOf,
      newId,
    },
    subscribe: (listener) => client.on(CORE_EVENTS.repairChanged, listener),
    inventory,
    ticketSyncStatuses: (ticketIds) => call('repair.ticketSyncStatuses', ticketIds),
    technicians: () => call('repair.technicians'),
    loadThumbnail: (ref) => call('repair.loadThumbnail', ref),
    loadModelPhoto: (photo) => call('repair.loadModelPhoto', photo),
    statusSite: deps.statusSite,
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
    async recordVideo(request) {
      const video = await capture.video(request);
      if (video === null) return null;
      const outcome = await call<CoreVideoOutcome>('media.importVideo', video);
      if (outcome.kind !== 'captured') throw new CaptureRefused(outcome.kind);
      return { videoRef: outcome.videoRef };
    },
    videoKept: (ref) => call<boolean>('media.hasLocal', ref.mediaId),
    playVideo: (ref, request) =>
      capture.play(request, async () =>
        playableVideo(await call<CoreVideoLoad>('media.loadVideo', ref)),
      ),
    printing,
    diagnostics: consoleDiagnostics,
  };
  return runtime;
}
