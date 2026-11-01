// Person sessions (least-privilege sync, owner decision 2026-11-01). A shared store device holds
// what its staff may read; a person who may read more there reads the rest online while they are
// signed in. Before serving any of it the server checks the person's PIN itself, against its own
// verifier, under its own lockout, so a tampered device cannot claim someone it never verified.
//
// A `bps_` token, stored hashed (as control sessions are), bound to one device and one person, for
// at most PERSON_SESSION_TTL_MS. Each use re-checks that the person is still active and a member of
// the device's store, so a deactivation or a move ends the session at once.
import type { TenantDb } from '@bolusi/db-server';

import { mintToken, sha256Hex } from '../crypto/index.js';
import { uuidv7 } from '../uuidv7.js';

/** A working day: long enough for one shift, short enough that a lost token goes stale. */
export const PERSON_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface MintedPersonSession {
  readonly token: string;
  readonly expiresAt: number;
}

export async function mintPersonSession(
  db: TenantDb,
  params: { tenantId: string; deviceId: string; userId: string; now: number },
): Promise<MintedPersonSession> {
  const token = mintToken('bps_');
  const expiresAt = params.now + PERSON_SESSION_TTL_MS;
  await db
    .insertInto('personSessions')
    .values({
      id: uuidv7(params.now),
      tenantId: params.tenantId,
      deviceId: params.deviceId,
      userId: params.userId,
      tokenHash: sha256Hex(token),
      createdAt: BigInt(params.now),
      expiresAt: BigInt(expiresAt),
    })
    .execute();
  return { token, expiresAt };
}

/**
 * Whether `userId` may act as themselves on this device: an active, non-system person of the
 * tenant who works at the device's store. The same test a PIN check, a session use and an acting
 * user claim make.
 */
export async function usableOnDevice(
  db: TenantDb,
  device: { readonly storeId: string | null },
  userId: string,
): Promise<boolean> {
  const user = await db
    .selectFrom('users')
    .select(['status', 'isSystem'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (user === undefined || user.isSystem || user.status !== 'active') return false;
  if (device.storeId === null) return true;
  const membership = await db
    .selectFrom('userStores')
    .select('userId')
    .where('userId', '=', userId)
    .where('storeId', '=', device.storeId)
    .executeTakeFirst();
  return membership !== undefined;
}

/** The person a token names on this device, or null when it is unknown, ended, or not usable. */
export async function personOfSession(
  db: TenantDb,
  params: {
    token: string;
    device: { readonly deviceId: string; readonly storeId: string | null };
    now: number;
  },
): Promise<string | null> {
  const row = await db
    .selectFrom('personSessions')
    .select(['userId', 'deviceId', 'expiresAt', 'revokedAt'])
    .where('tokenHash', '=', sha256Hex(params.token))
    .executeTakeFirst();
  if (row === undefined || row.deviceId !== params.device.deviceId) return null;
  if (row.revokedAt !== null || Number(row.expiresAt) <= params.now) return null;
  return (await usableOnDevice(db, params.device, row.userId)) ? row.userId : null;
}

/** End a session (sign-out, switch, lock). Ending one that is already over changes nothing. */
export async function endPersonSession(
  db: TenantDb,
  params: { token: string; deviceId: string; now: number },
): Promise<void> {
  await db
    .updateTable('personSessions')
    .set({ revokedAt: BigInt(params.now) })
    .where('tokenHash', '=', sha256Hex(params.token))
    .where('deviceId', '=', params.deviceId)
    .where('revokedAt', 'is', null)
    .execute();
}

/** End every live session of `userId`: their PIN changed, so whoever opened one with the old PIN is out. */
export async function endPersonSessionsOf(
  db: TenantDb,
  params: { userId: string; now: number; keepDeviceId?: string },
): Promise<void> {
  let update = db
    .updateTable('personSessions')
    .set({ revokedAt: BigInt(params.now) })
    .where('userId', '=', params.userId)
    .where('revokedAt', 'is', null);
  if (params.keepDeviceId !== undefined)
    update = update.where('deviceId', '<>', params.keepDeviceId);
  await update.execute();
}
