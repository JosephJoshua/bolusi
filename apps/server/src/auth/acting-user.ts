// X-Acting-User trust model (api/02-auth §4.5). Control-plane calls arrive either on a control
// session (the acting user IS the session user, already validated by verifyToken) or on a device
// token carrying `X-Acting-User: <userId>`. For the device case the server verifies the claimed
// user is usable on THIS device (§5.1: device.storeId ∈ user.storeIds) and in this tenant; a
// missing / unknown / other-tenant / not-usable claim fails closed with ACTING_USER_INVALID. It
// TRUSTS the device to have PIN-verified the user locally — the same trust root as op attribution.
//
// This is a handler-invoked helper, not a standalone Hono middleware: the usability check is a
// tenant-table read, so it runs INSIDE the endpoint's forTenant transaction (one tx per request)
// rather than opening a second one. (Deviation from the task file's "middleware" wording, flagged.)
import type { TenantDb } from '@bolusi/db-server';
import type { Context } from 'hono';

import type { AppEnv } from '../env.js';
import { ApiError } from '../errors.js';
import { IdentityError } from '../identity/errors.js';

export interface ActingUser {
  readonly userId: string;
  readonly tenantId: string;
  /** The evaluation store for permission scope (§5.2): the device's store, or null on a control session. */
  readonly deviceStoreId: string | null;
}

/**
 * Resolve + validate the acting user for a control-plane request, inside `db` (the request's
 * forTenant tx). Throws `ACTING_USER_INVALID` (403) when the claim is missing/unknown/other-tenant
 * /not-usable.
 */
export async function resolveActingUser(c: Context<AppEnv>, db: TenantDb): Promise<ActingUser> {
  const control = c.get('controlSession');
  if (control !== undefined) {
    return { userId: control.userId, tenantId: control.tenantId, deviceStoreId: null };
  }

  const device = c.get('device');
  if (device !== undefined) {
    const claimed = c.req.header('X-Acting-User');
    if (claimed === undefined || claimed === '') throw new IdentityError('ACTING_USER_INVALID');

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
