// Role-limits sub-router (product-scope.md, "Managers, limits, approvals and roles"). A store owner
// sets how far each limited role (a manager) may go at their store: price drops, refunds and
// Bayar nanti, per servisan. Online only, like every directory change: devices get the new amounts
// with their next bundle, and the server judges every synced op by the amounts here.
import { Hono } from 'hono';

import { resolveActingUser } from '../auth/acting-user.js';
import { requirePermission } from '../auth/permissions.js';
import type { ServerDeps } from '../deps.js';
import type { AppEnv } from '../env.js';
import { ApiError } from '../errors.js';
import { appendAudit } from '../identity/audit.js';
import { PermissionDeniedError } from '../identity/denial-audit.js';
import { withIdentityErrors } from '../identity/errors.js';
import { PERM } from '../identity/permissions.js';
import { LIMIT_KINDS } from '@bolusi/core';
import { PutRoleLimitsReq } from '@bolusi/schemas';
import { zJson } from '../middleware/validator-hook.js';
import { announceDirectoryChange } from '../realtime/announce.js';
import { createWithTenant, tenantIdFromContext } from '../tenant.js';

export function createRoleLimitsRouter(deps: ServerDeps) {
  const withTenant = createWithTenant(deps.forTenant);

  return new Hono<AppEnv>().put('/', zJson(PutRoleLimitsReq), (c) =>
    withIdentityErrors(c, async () => {
      const body = c.req.valid('json');
      const t = deps.now();
      const tenantId = tenantIdFromContext(c);

      await withTenant(c, async (db) => {
        const acting = await resolveActingUser(c, db);
        // The store and the role must be this business's (RLS hides another's): a miss is a
        // denial, never a 404 that would confirm an id exists elsewhere.
        const store = await db
          .selectFrom('stores')
          .select('id')
          .where('id', '=', body.storeId)
          .executeTakeFirst();
        if (store === undefined) throw new ApiError('PERMISSION_DENIED');
        await requirePermission(db, {
          userId: acting.userId,
          tenantId,
          storeId: body.storeId,
          permissionId: PERM.limitManage,
        });
        const role = await db
          .selectFrom('roles')
          .select(['id', 'limited'])
          .where('id', '=', body.roleId)
          .executeTakeFirst();
        if (role === undefined || !role.limited) throw new ApiError('PERMISSION_DENIED');
        // Nobody raises their own limit: whoever holds this role at this store sets none of its
        // amounts there, whatever else they hold.
        const holds = await db
          .selectFrom('userRoles')
          .select('userId')
          .where('userId', '=', acting.userId)
          .where('roleId', '=', body.roleId)
          .where((eb) => eb.or([eb('storeId', '=', body.storeId), eb('storeId', 'is', null)]))
          .executeTakeFirst();
        if (holds !== undefined) {
          throw new PermissionDeniedError({
            actorUserId: acting.userId,
            permissionId: PERM.limitManage,
            scopeStoreId: body.storeId,
            reason: 'restriction_violated',
          });
        }

        const before = await db
          .selectFrom('roleLimits')
          .select(['kind', 'amount'])
          .where('roleId', '=', body.roleId)
          .where('storeId', '=', body.storeId)
          .execute();
        for (const kind of LIMIT_KINDS) {
          await db
            .insertInto('roleLimits')
            .values({
              tenantId,
              roleId: body.roleId,
              storeId: body.storeId,
              kind,
              amount: BigInt(body[kind]),
              updatedBy: acting.userId,
              updatedAt: BigInt(t),
            })
            .onConflict((oc) =>
              oc.columns(['roleId', 'storeId', 'kind']).doUpdateSet({
                amount: BigInt(body[kind]),
                updatedBy: acting.userId,
                updatedAt: BigInt(t),
              }),
            )
            .execute();
        }

        await appendAudit(db, tenantId, {
          actorUserId: acting.userId,
          action: 'role_limits.changed',
          entityType: 'role',
          entityId: body.roleId,
          before: {
            storeId: body.storeId,
            ...Object.fromEntries(before.map((row) => [row.kind, Number(row.amount)])),
          },
          after: {
            storeId: body.storeId,
            priceDrop: body.priceDrop,
            refund: body.refund,
            credit: body.credit,
          },
          at: t,
        });
      });

      announceDirectoryChange(deps, tenantId);
      return c.json({ roleId: body.roleId, storeId: body.storeId });
    }),
  );
}
