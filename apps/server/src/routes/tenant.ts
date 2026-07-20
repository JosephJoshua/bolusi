// Tenant-settings sub-router (api/02-auth §6.4). PATCH requires auth.tenant_configure; idleLock
// clamped 60–3600; audited; the change flips the bundle etag (buildBundle reads
// tenants.configuration.idleLockSeconds).
import { Hono } from 'hono';

import { resolveActingUser } from '../auth/acting-user.js';
import { requirePermission } from '../auth/permissions.js';
import type { ServerDeps } from '../deps.js';
import type { AppEnv } from '../env.js';
import { appendAudit } from '../identity/audit.js';
import { withIdentityErrors } from '../identity/errors.js';
import { PERM } from '../identity/permissions.js';
import { clampIdleLock, IDLE_LOCK_DEFAULT, TenantSettingsReq } from '../identity/schemas.js';
import { zJson } from '../middleware/validator-hook.js';
import { createWithTenant, tenantIdFromContext } from '../tenant.js';

function readIdle(configuration: unknown): number {
  if (configuration !== null && typeof configuration === 'object') {
    const raw = (configuration as Record<string, unknown>)['idleLockSeconds'];
    if (typeof raw === 'number' && Number.isFinite(raw)) return clampIdleLock(raw);
  }
  return IDLE_LOCK_DEFAULT;
}

export function createTenantRouter(deps: ServerDeps) {
  const withTenant = createWithTenant(deps.forTenant);

  return new Hono<AppEnv>().patch('/settings', zJson(TenantSettingsReq), (c) =>
    withIdentityErrors(c, async () => {
      const body = c.req.valid('json');
      const t = deps.now();
      const tenantId = tenantIdFromContext(c);

      const settings = await withTenant(c, async (db) => {
        const acting = await resolveActingUser(c, db);
        // tenant_configure is tenant-scoped → only a tenant-wide grant satisfies it.
        await requirePermission(db, {
          userId: acting.userId,
          tenantId,
          storeId: acting.deviceStoreId,
          permissionId: PERM.tenantConfigure,
        });

        const tenant = await db
          .selectFrom('tenants')
          .select(['configuration'])
          .where('id', '=', tenantId)
          .executeTakeFirstOrThrow();
        const before = readIdle(tenant.configuration);
        const clamped = clampIdleLock(body.idleLockSeconds);
        const existing =
          tenant.configuration !== null && typeof tenant.configuration === 'object'
            ? (tenant.configuration as Record<string, unknown>)
            : {};
        const nextConfig = { ...existing, idleLockSeconds: clamped };

        await db
          .updateTable('tenants')
          .set({ configuration: nextConfig as never })
          .where('id', '=', tenantId)
          .execute();

        await appendAudit(db, tenantId, {
          actorUserId: acting.userId,
          action: 'tenant_settings.changed',
          entityType: 'tenant_settings',
          entityId: tenantId,
          before: { idleLockSeconds: before },
          after: { idleLockSeconds: clamped },
          at: t,
        });

        return { idleLockSeconds: clamped };
      });

      return c.json({ settings });
    }),
  );
}
