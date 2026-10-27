/**
 * Test support for the repair screen tests: a REAL `RepairRuntime` over the repair module harness
 * (in-memory SQLite, real commands, queries and projections), with a user directory so the
 * technician picker has names, and fake capture that hands back fresh signed refs.
 */
import idCatalog from '@bolusi/modules/repair/i18n/id.json';
import enCatalog from '@bolusi/modules/repair/i18n/en.json';
import { registerRepairCatalog, type RepairRuntime } from '@bolusi/modules/repair/screens';
import { act } from 'react';

import {
  openRepairHarness,
  intake,
  type RepairHarness,
} from '../../../packages/modules/test/support/repair-harness.js';
import { fire, render, textsIn, type RenderResult } from '../../../packages/ui/test/render.js';
import { createRepairRuntime } from '../src/screens/repair/runtime-adapter.js';

export { openRepairHarness, intake, render, fire, textsIn, type RepairHarness, type RenderResult };

export function ensureRepairCatalog(): void {
  registerRepairCatalog({ id: idCatalog, en: enCatalog });
}

export const USER_NAMES = {
  cashier: 'Maria Kasir',
  technician: 'Budi Teknisi',
  technician2: 'Yosua Teknisi',
  zero: 'Tamu',
  storeOwner: 'Yohana Pemilik',
} as const;

/**
 * The harness plus the users directory the technician picker and ticket names read. Given `peerOf`,
 * a second device in the same store with the same staff, for changes that arrive by sync.
 */
export async function openRepairScreenHarness(
  seed: number,
  peerOf?: RepairHarness,
): Promise<RepairHarness> {
  const h = await openRepairHarness(
    seed,
    peerOf === undefined
      ? undefined
      : {
          tenantId: peerOf.tenantId,
          storeId: peerOf.storeId,
          users: [
            peerOf.cashierId,
            peerOf.technicianId,
            peerOf.technician2Id,
            peerOf.zeroUserId,
            peerOf.ownerId,
            peerOf.storeOwnerId,
          ],
        },
  );
  await h.db
    .insertInto('usersDirectory')
    .values([
      { id: h.cashierId, name: USER_NAMES.cashier, photoMediaId: null, status: 'active' },
      { id: h.technicianId, name: USER_NAMES.technician, photoMediaId: null, status: 'active' },
      { id: h.technician2Id, name: USER_NAMES.technician2, photoMediaId: null, status: 'active' },
      { id: h.zeroUserId, name: USER_NAMES.zero, photoMediaId: null, status: 'active' },
      { id: h.storeOwnerId, name: USER_NAMES.storeOwner, photoMediaId: null, status: 'active' },
    ])
    .execute();
  return h;
}

/** Hand `to` every op `from` wrote that it has not seen yet, the way a pull delivers them. */
export async function pull(to: RepairHarness, from: RepairHarness): Promise<void> {
  const known = await to.db.selectFrom('operations').select(['id', 'arrivalSeq']).execute();
  const seen = new Set(known.map((row) => row.id));
  let arrival = Math.max(0, ...known.map((row) => row.arrivalSeq ?? 0));
  for (const op of await from.ownOps()) {
    if (!seen.has(op.id)) await to.deliverPulled(op, (arrival += 1));
  }
}

/** A real runtime for `userId`; every photo or signature "taken" is a fresh signed ref. */
export function repairRuntimeFor(h: RepairHarness, userId: string): RepairRuntime {
  let shot = 100;
  return createRepairRuntime({
    runtime: h.runtime,
    db: h.db,
    invalidation: h.engine.invalidation,
    identity: { tenantId: h.tenantId, storeId: h.storeId, deviceId: h.deviceId, userId },
    media: {
      capturePhoto: () => Promise.resolve({ mediaRef: h.photo((shot += 1)) }),
      captureSignature: () =>
        Promise.resolve({ mediaRef: { ...h.photo((shot += 1)), mime: 'image/png' } }),
      loadThumbnail: () => Promise.resolve({ kind: 'unavailable' }),
      loadModelPhoto: (photo) => Promise.resolve(`file:///phone-models/${photo.modelId}.jpg`),
    },
  });
}

/** Let queued promises and the effects they trigger run. */
export async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
}

/** Press the control with `testID` and let what it started finish. */
export async function press(screen: RenderResult, testID: string): Promise<void> {
  fire(screen.all(testID)[0]!, 'onPress');
  await settle();
}

/** Type into the text input whose testID is `testID`. */
export function type(screen: RenderResult, testID: string, text: string): void {
  fire(screen.get(`${testID}.field`), 'onChangeText', text);
}

export function text(screen: RenderResult, testID: string): string {
  return textsIn(screen.all(testID)[0]!).join('');
}
