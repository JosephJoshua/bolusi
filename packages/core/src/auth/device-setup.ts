// The first-run setup of a newly registered phone or PC: who it is for, and whether it is done.
// Enrolment hands it to the owner who registered the device, once; finishing or skipping it ends it
// for good, and a device registered again after that does not ask again. It is the device's own
// state, so it lives in `meta_kv` and never syncs.
import type { Kysely } from 'kysely';

import { readMeta, writeMeta } from './repo.js';

/** `meta_kv` key: `done`, or `pending:<userId>` naming the owner the setup waits for. */
export const DEVICE_SETUP_META_KEY = 'auth.deviceSetup';

const DONE = 'done';
const PENDING = 'pending:';

/** Enrolment: the setup waits for `ownerUserId`, unless this device finished it before. */
export async function markDeviceSetupPending<DB>(
  db: Kysely<DB>,
  ownerUserId: string,
): Promise<void> {
  if ((await readMeta(db, DEVICE_SETUP_META_KEY)) === DONE) return;
  await writeMeta(db, DEVICE_SETUP_META_KEY, `${PENDING}${ownerUserId}`);
}

/**
 * The person the setup waits for, or null when there is none: finished, or a device registered
 * before setup existed (already in use, so it is not stopped for one).
 */
export async function readDeviceSetupFor<DB>(db: Kysely<DB>): Promise<string | null> {
  const value = await readMeta(db, DEVICE_SETUP_META_KEY);
  return value?.startsWith(PENDING) === true ? value.slice(PENDING.length) || null : null;
}

/** Finished or skipped: it does not open by itself again (Settings still offers it). */
export async function finishDeviceSetup<DB>(db: Kysely<DB>): Promise<void> {
  await writeMeta(db, DEVICE_SETUP_META_KEY, DONE);
}
