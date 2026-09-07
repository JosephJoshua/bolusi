// The PGlite mirror of the production D14 auth-entry lookups (10-db-schema §6.4), for task 201-B:
// standing the REAL `@bolusi/server` up on the serverless emulator lane with its DB-backed auth path
// ENGAGED. `HarnessServer.boot({ productionAuth: true })` injects the directory this builds and OMITS
// `verifyToken`, so production `resolveDeps` wires `createDbVerifyToken(authDirectory)` (deps.ts:378)
// and `POST /v1/auth/login` resolves credentials through `findLoginCredential` — every request's token
// verify and every login run the real definer lookups over PGlite (WASM Postgres).
//
// WHY A MIRROR, NOT A REUSE (T-7 / the db-server encapsulation). The production `dbAuthDirectory`
// (auth/directory.ts) binds these three lookups to db-server's INTERNAL `getDb()` — a PG16 pool the
// harness has no handle to, and must not (index.ts: "an unscoped query must be impossible to express";
// `getDb` is deliberately unexported). The `AuthDirectory` port exists precisely so a test can swap the
// DRIVER while keeping the SQL. This module keeps the security boundary intact: it exposes ONLY the
// three fixed, keyed, definer-gated lookups — never a raw handle, never an arbitrary cross-tenant
// query — so an unscoped SELECT stays inexpressible here exactly as in db-server.
//
// FIDELITY (emulator-lane-hops discipline: verify each new hop against a faithful oracle). The three
// bodies are `packages/db-server/src/auth-entry.ts` VERBATIM — identical SQL, identical explicit column
// aliases, identical `Number()` coercion for the control-session int8 columns — with the single, sole
// delta being the driver: `.execute(getDb())` → `.execute(db)`. The db-server record types are imported
// (not re-declared) so a field drift in the oracle is a compile error here, not a silent divergence.
import { sql, type Kysely } from 'kysely';

import type {
  ControlSessionAuthRecord,
  DB,
  DeviceAuthRecord,
  LoginCredentialRecord,
} from '@bolusi/db-server';

/**
 * The three D14 cross-tenant auth lookups, structurally the server-internal `AuthDirectory` port
 * (apps/server/src/auth/directory.ts) — mirrored here because that type is not exported from
 * `@bolusi/server`'s public surface. `HarnessServer.boot` spreads a value of this shape into the
 * `createApp` overrides as `authDirectory`; the whole overrides object crosses the package boundary
 * via one structural cast, exactly as the harness already does for `forTenant`/`verifyToken`.
 */
export interface PgliteAuthDirectory {
  findDeviceByTokenHash(tokenHashHex: string): Promise<DeviceAuthRecord | undefined>;
  findControlSessionByTokenHash(
    tokenHashHex: string,
  ): Promise<ControlSessionAuthRecord | undefined>;
  findLoginCredential(loginIdentifier: string): Promise<LoginCredentialRecord | undefined>;
}

/**
 * Build the production D14 auth directory over a harness PGlite `db` (mirrors `auth-entry.ts`).
 *
 * Every SELECT names its columns with explicit quoted aliases — the same as the oracle — so the result
 * shape is correct whether or not the `db` carries the `CamelCasePlugin` (the harness handle does; the
 * aliases make it robust regardless). Each lookup returns the single matched row's minimal fields, or
 * `undefined` on no match (fail closed), exactly as the definer functions do.
 */
export function createPgliteAuthDirectory(db: Kysely<DB>): PgliteAuthDirectory {
  return {
    async findDeviceByTokenHash(tokenHashHex) {
      const { rows } = await sql<{
        tenantId: string;
        storeId: string | null;
        deviceId: string;
        status: string;
      }>`
        SELECT tenant_id AS "tenantId", store_id AS "storeId", device_id AS "deviceId", status
          FROM auth_find_device_by_token_hash(${tokenHashHex})
      `.execute(db);
      return rows[0];
    },

    async findControlSessionByTokenHash(tokenHashHex) {
      const { rows } = await sql<{
        tenantId: string;
        userId: string;
        sessionId: string;
        expiresAt: string | number;
        revokedAt: string | number | null;
      }>`
        SELECT tenant_id AS "tenantId", user_id AS "userId", session_id AS "sessionId",
               expires_at AS "expiresAt", revoked_at AS "revokedAt"
          FROM auth_find_control_session_by_token_hash(${tokenHashHex})
      `.execute(db);
      const row = rows[0];
      if (row === undefined) return undefined;
      return {
        tenantId: row.tenantId,
        userId: row.userId,
        sessionId: row.sessionId,
        expiresAt: Number(row.expiresAt),
        revokedAt: row.revokedAt === null ? null : Number(row.revokedAt),
      };
    },

    async findLoginCredential(loginIdentifier) {
      const { rows } = await sql<{
        tenantId: string;
        userId: string;
        passwordVerifier: string | null;
        status: string;
      }>`
        SELECT tenant_id AS "tenantId", user_id AS "userId",
               password_verifier AS "passwordVerifier", status
          FROM auth_find_login_credential(${loginIdentifier})
      `.execute(db);
      return rows[0];
    },
  };
}
