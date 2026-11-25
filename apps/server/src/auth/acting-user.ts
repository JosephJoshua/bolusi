// Who acts on a control-plane call (api/02-auth §4.5). Calls arrive either on a control session (the
// acting user IS the session user, already validated by verifyToken) or on a device token carrying
// `X-Acting-User: <userId>`.
//
// A device token proves the DEVICE, never the person: anyone who copies it off the counter PC (sealed
// only to its shared Windows account) or a rooted phone could name any colleague. So the server takes
// the person only on proof it checked itself:
//   - someone's own phone (a personal device) acts only as that person, as its ops are only theirs;
//   - a store's shared device acts as a person only with their person session (`X-Person-Session`),
//     which the server opened after checking their PIN against its own verifier, on this device.
// Anything else fails closed with ACTING_USER_INVALID. Every control-plane route resolves its actor
// here, so no route can take a person on the device's word.
//
// This is a handler-invoked helper, not a standalone Hono middleware: the checks are tenant-table
// reads, so they run INSIDE the endpoint's forTenant transaction (one tx per request).
import { PERSON_SESSION_HEADER } from '@bolusi/schemas';
import type { TenantDb } from '@bolusi/db-server';
import type { Context } from 'hono';

import type { AppEnv } from '../env.js';
import { ApiError } from '../errors.js';
import { IdentityError } from '../identity/errors.js';
import { personOfSession } from './person-sessions.js';

export interface ActingUser {
  readonly userId: string;
  readonly tenantId: string;
  /** The evaluation store for permission scope (§5.2): the device's store, or null on a control session. */
  readonly deviceStoreId: string | null;
}

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Resolve + validate the acting user for a control-plane request, inside `db` (the request's
 * forTenant tx). Throws `ACTING_USER_INVALID` (403) when the claim is missing, unknown, of another
 * tenant, not usable on this device, or not proven there (see the header).
 */
export async function resolveActingUser(
  c: Context<AppEnv>,
  db: TenantDb,
  now: number,
): Promise<ActingUser> {
  const control = c.get('controlSession');
  if (control !== undefined) {
    return { userId: control.userId, tenantId: control.tenantId, deviceStoreId: null };
  }
  const acting = await provenActingUser(c, db, now);
  if (acting === null) throw new IdentityError('ACTING_USER_INVALID');
  return acting;
}

/**
 * The person a device names, when it is one of this tenant usable here (else ACTING_USER_INVALID),
 * and null when the device cannot prove them. For the one call that registers a person without
 * needing them proven (a push token, routes/push.ts), which then records nobody.
 */
export async function provenActingUser(
  c: Context<AppEnv>,
  db: TenantDb,
  now: number,
): Promise<ActingUser | null> {
  const acting = await claimedActingUser(c, db);
  if (acting === null) throw new ApiError('INTERNAL');
  return (await provenOnDevice(c, db, acting, now)) ? acting : null;
}

/**
 * Whether the person a device names is proven there: the person its personal device is for, or the
 * holder of a live person session on this shared device.
 */
async function provenOnDevice(
  c: Context<AppEnv>,
  db: TenantDb,
  acting: ActingUser,
  now: number,
): Promise<boolean> {
  const device = c.get('device');
  const row = await db
    .selectFrom('devices')
    .select('personalUserId')
    .where('id', '=', device.deviceId)
    .executeTakeFirst();
  if (row === undefined) return false;
  if (row.personalUserId !== null) return row.personalUserId === acting.userId;
  const token = c.req.header(PERSON_SESSION_HEADER);
  if (token === undefined) return false;
  const person = await personOfSession(db, { token, device, now });
  return person === acting.userId;
}

/**
 * The person a device names, before any proof: one of this tenant, usable on this device. Null on a
 * control session. Only the first-PIN exception (routes/users.ts) uses it bare, with its own proof.
 */
export async function claimedActingUser(
  c: Context<AppEnv>,
  db: TenantDb,
): Promise<ActingUser | null> {
  if (c.get('controlSession') !== undefined) return null;

  const device = c.get('device');
  if (device !== undefined) {
    const claimed = c.req.header('X-Acting-User');
    // Shape first (ids are lowercase uuids): a non-uuid would reach Postgres as a cast error (a 500), and a repeated header
    // arrives joined ("a, b"). Either is simply not a user.
    if (claimed === undefined || !USER_ID.test(claimed)) {
      throw new IdentityError('ACTING_USER_INVALID');
    }

    // Exists in THIS tenant? RLS scopes the read, so an other-tenant id reads as absent.
    const user = await db
      .selectFrom('users')
      .select(['id', 'isSystem'])
      .where('id', '=', claimed)
      .executeTakeFirst();
    if (user === undefined || user.isSystem) throw new IdentityError('ACTING_USER_INVALID');

    // Usable on this device (§5.1): the device's store is one of the user's stores.
    if (device.storeId !== null) {
      const membership = await db
        .selectFrom('userStores')
        .select('userId')
        .where('userId', '=', claimed)
        .where('storeId', '=', device.storeId)
        .executeTakeFirst();
      if (membership === undefined) throw new IdentityError('ACTING_USER_INVALID');
    }

    return { userId: claimed, tenantId: device.tenantId, deviceStoreId: device.storeId };
  }

  // No principal on a bearer-guarded route is a routing/middleware bug, not a client error.
  throw new ApiError('INTERNAL');
}
