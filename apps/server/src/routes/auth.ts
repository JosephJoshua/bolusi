// Auth/identity sub-router (api/02-auth §4.2 login, §5.4 password). `POST /v1/auth/login` is the
// only bearer-exempt route (api/00 §1, §3); it resolves the tenant through the D14 cross-tenant
// lookup, runs the KDF (real or dummy) unconditionally so unknown-identifier and wrong-password
// are indistinguishable, and mints a hashed-at-rest control session.
import { Hono } from 'hono';

import type { ServerDeps } from '../deps.js';
import type { AppEnv } from '../env.js';
import { resolveActingUser } from '../auth/acting-user.js';
import { mintControlSession } from '../auth/control-sessions.js';
import { storesGranting } from '../auth/permissions.js';
import { appendAudit } from '../identity/audit.js';
import { IdentityError, withIdentityErrors } from '../identity/errors.js';
import { PERM } from '../identity/permissions.js';
import { enforce, IDENTITY_LIMITS } from '../identity/rate-limits.js';
import { LoginReq, PasswordChangeReq, type LoginRes } from '@bolusi/schemas';
import { zJson } from '../middleware/validator-hook.js';
import { createWithTenant } from '../tenant.js';

export function createAuthRouter(deps: ServerDeps) {
  const withTenant = createWithTenant(deps.forTenant);

  return new Hono<AppEnv>()
    .post('/login', zJson(LoginReq), (c) =>
      withIdentityErrors(c, async () => {
        const body = c.req.valid('json');
        const t = deps.now();

        // §9: 30 requests / IP / hour (pre-auth, per source IP).
        enforce(
          deps.identityRateStore.hit(
            `login-ip:${deps.clientIp(c)}`,
            IDENTITY_LIMITS.loginRequestsPerIp.limit,
            IDENTITY_LIMITS.loginRequestsPerIp.windowMs,
            t,
          ),
        );
        // §9: 5 failures / identifier / 15 min → locked. Checked (not incremented) up front.
        enforce(
          deps.identityRateStore.check(
            `login-fail:${body.loginIdentifier}`,
            IDENTITY_LIMITS.loginFailPerIdentifier.limit,
            IDENTITY_LIMITS.loginFailPerIdentifier.windowMs,
            t,
          ),
        );

        const cred = await deps.authDirectory.findLoginCredential(body.loginIdentifier);

        const fail = async (): Promise<never> => {
          deps.identityRateStore.add(
            `login-fail:${body.loginIdentifier}`,
            IDENTITY_LIMITS.loginFailPerIdentifier.windowMs,
            t,
          );
          throw new IdentityError('AUTH_INVALID_CREDENTIALS');
        };

        // Unknown identifier or a password-less user: run the DUMMY KDF anyway (no early return →
        // no enumeration oracle), then fail with the same body as a wrong password.
        if (cred === undefined || cred.passwordVerifier === null) {
          await deps.passwordKdf.runDummy(body.password);
          return fail();
        }

        const ok = await deps.passwordKdf.verify(body.password, cred.passwordVerifier);
        if (!ok || cred.status !== 'active') return fail();

        // Success: mint the session + gather the store list, under the resolved tenant.
        const result = await deps.forTenant(cred.tenantId, async (db) => {
          const session = await mintControlSession(db, {
            tenantId: cred.tenantId,
            userId: cred.userId,
            now: t,
          });
          // The tenant's display name — the enrollment confirm step renders it (api/02-auth §4.2)
          // so the owner reads what they are binding to before the irreversible enroll POST. Read
          // here, not fabricated client-side: the wire carries the fact, never a guess (T-19).
          const tenant = await db
            .selectFrom('tenants')
            .select(['name'])
            .where('id', '=', cred.tenantId)
            .executeTakeFirstOrThrow();
          const user = await db
            .selectFrom('users')
            .select(['id', 'name'])
            .where('id', '=', cred.userId)
            .executeTakeFirstOrThrow();
          // Only the stores this user may enroll a phone into (§4.2 `LoginRes.stores`): an empty
          // list tells the wizard at its first step that this is not an owner, instead of after the
          // phone is named. The enroll route still checks the permission itself.
          const enrollable = await storesGranting(db, {
            tenantId: cred.tenantId,
            userId: cred.userId,
            permissionId: PERM.deviceEnroll,
          });
          const stores = (
            await db
              .selectFrom('userStores')
              .innerJoin('stores', 'stores.id', 'userStores.storeId')
              .select(['stores.id as id', 'stores.name as name'])
              .where('userStores.userId', '=', cred.userId)
              .orderBy('stores.id')
              .execute()
          ).filter((store) => enrollable.storeIds.includes(store.id));
          await appendAudit(db, cred.tenantId, {
            actorUserId: cred.userId,
            action: 'auth.login',
            entityType: 'control_session',
            entityId: session.sessionId,
            after: { userId: cred.userId },
            at: t,
          });
          return { session, user, stores, tenant };
        });

        const res: LoginRes = {
          controlSession: result.session.token,
          expiresAt: result.session.expiresAt,
          tenantId: cred.tenantId,
          tenantName: result.tenant.name,
          user: { id: result.user.id, name: result.user.name },
          stores: result.stores.map((s) => ({ id: s.id, name: s.name })),
        };
        return c.json(res);
      }),
    )
    .post('/password', zJson(PasswordChangeReq), (c) =>
      withIdentityErrors(c, async () => {
        const body = c.req.valid('json');
        const t = deps.now();
        return withTenant(c, async (db) => {
          const acting = await resolveActingUser(c, db);
          // §9: 5 / user / day.
          enforce(
            deps.identityRateStore.hit(
              `password:${acting.userId}`,
              IDENTITY_LIMITS.passwordPerUserDay.limit,
              IDENTITY_LIMITS.passwordPerUserDay.windowMs,
              t,
            ),
          );
          const user = await db
            .selectFrom('users')
            .select(['passwordVerifier'])
            .where('id', '=', acting.userId)
            .executeTakeFirst();
          if (user === undefined || user.passwordVerifier === null) {
            throw new IdentityError('AUTH_INVALID_CREDENTIALS');
          }
          if (!(await deps.passwordKdf.verify(body.currentPassword, user.passwordVerifier))) {
            throw new IdentityError('AUTH_INVALID_CREDENTIALS');
          }
          const newVerifier = await deps.passwordKdf.createVerifier(body.newPassword);
          await db
            .updateTable('users')
            .set({ passwordVerifier: newVerifier })
            .where('id', '=', acting.userId)
            .execute();
          await appendAudit(db, acting.tenantId, {
            actorUserId: acting.userId,
            action: 'password.changed',
            entityType: 'user',
            entityId: acting.userId,
            at: t,
          });
          return c.json({ userId: acting.userId });
        });
      }),
    );
}
