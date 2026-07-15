// Auth/identity sub-router (api/02-auth §4.2 login, §5.4 password). `POST /v1/auth/login` is the
// only bearer-exempt route (api/00 §1, §3); it resolves the tenant through the D14 cross-tenant
// lookup, runs the KDF (real or dummy) unconditionally so unknown-identifier and wrong-password
// are indistinguishable, and mints a hashed-at-rest control session.
import { Hono } from 'hono';

import type { ServerDeps } from '../deps.js';
import type { AppEnv } from '../env.js';
import { resolveActingUser } from '../auth/acting-user.js';
import { mintControlSession } from '../auth/control-sessions.js';
import { appendAudit } from '../identity/audit.js';
import { IdentityError, withIdentityErrors } from '../identity/errors.js';
import { enforce, IDENTITY_LIMITS } from '../identity/rate-limits.js';
import { LoginReq, PasswordChangeReq, type LoginRes } from '../identity/schemas.js';
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
          const user = await db
            .selectFrom('users')
            .select(['id', 'name'])
            .where('id', '=', cred.userId)
            .executeTakeFirstOrThrow();
          const stores = await db
            .selectFrom('userStores')
            .innerJoin('stores', 'stores.id', 'userStores.storeId')
            .select(['stores.id as id', 'stores.name as name'])
            .where('userStores.userId', '=', cred.userId)
            .orderBy('stores.id')
            .execute();
          await appendAudit(db, cred.tenantId, {
            actorUserId: cred.userId,
            action: 'auth.login',
            entityType: 'control_session',
            entityId: session.sessionId,
            after: { userId: cred.userId },
            at: t,
          });
          return { session, user, stores };
        });

        const res: LoginRes = {
          controlSession: result.session.token,
          expiresAt: result.session.expiresAt,
          tenantId: cred.tenantId,
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
