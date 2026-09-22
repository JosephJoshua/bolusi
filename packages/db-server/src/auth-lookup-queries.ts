/**
 * The three D14 auth-lookup QUERIES — shared SQL, not shared execution (task 204, approach 1).
 *
 * WHY THIS SHAPE, AND NOT A FUNCTION THAT TAKES A HANDLE. `auth-entry.ts` keeps `getDb` deliberately
 * unexported so that "an arbitrary cross-tenant query is impossible to express" through this package
 * (08 §3.2 / D7 / FR-1039). The obvious dedup — hoisting the three bodies into functions
 * parameterised over a `Kysely<DB>` — would thread an external handle straight into db-server's
 * authz path, which task 204 calls out as a §6 security-control change requiring an owner decision.
 *
 * So only the QUERY is shared. Each builder returns an unexecuted Kysely `sql` fragment; the caller
 * supplies its own handle at `.execute()`. `@bolusi/db-server` still exports no handle and no way to
 * obtain one, the SECURITY DEFINER gating stays exactly where it was, and the thing that actually
 * drifted — the column list, the quoted aliases, the int8 coercion — now lives once.
 *
 * What this fixes: the aliases were string literals duplicated between `auth-entry.ts` and the
 * harness's `production-auth.ts` mirror. Renaming a definer column on one side left the other
 * silently selecting the old name with NO compile error, so the emulator lane would keep reporting a
 * "production-auth" path that no longer mirrored production.
 */
import { sql } from 'kysely';

/** Raw device row as the definer function returns it. */
export interface DeviceAuthRow {
  readonly tenantId: string;
  readonly storeId: string | null;
  readonly deviceId: string;
  readonly status: string;
}

/** Raw control-session row. `int8` columns arrive as string or number depending on the driver. */
export interface ControlSessionAuthRow {
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly expiresAt: string | number;
  readonly revokedAt: string | number | null;
}

/** Raw login-credential row. */
export interface LoginCredentialRow {
  readonly tenantId: string;
  readonly userId: string;
  readonly passwordVerifier: string | null;
  readonly status: string;
}

/**
 * Resolve a device by SHA-256 token hash (hex). Cross-tenant, definer-gated.
 *
 * Every column carries an explicit quoted alias so the result shape is correct whether or not the
 * executing handle has the `CamelCasePlugin` (the server's does; the harness's PGlite handle does
 * too — the aliases make it independent of that).
 */
export function deviceByTokenHashQuery(tokenHashHex: string) {
  return sql<DeviceAuthRow>`
    SELECT tenant_id AS "tenantId", store_id AS "storeId", device_id AS "deviceId", status
      FROM auth_find_device_by_token_hash(${tokenHashHex})
  `;
}

/** Resolve a control session by SHA-256 token hash (hex). Cross-tenant, definer-gated. */
export function controlSessionByTokenHashQuery(tokenHashHex: string) {
  return sql<ControlSessionAuthRow>`
    SELECT tenant_id AS "tenantId", user_id AS "userId", session_id AS "sessionId",
           expires_at AS "expiresAt", revoked_at AS "revokedAt"
      FROM auth_find_control_session_by_token_hash(${tokenHashHex})
  `;
}

/** Resolve a user by globally-unique loginIdentifier. Cross-tenant, definer-gated. */
export function loginCredentialQuery(loginIdentifier: string) {
  return sql<LoginCredentialRow>`
    SELECT tenant_id AS "tenantId", user_id AS "userId",
           password_verifier AS "passwordVerifier", status
      FROM auth_find_login_credential(${loginIdentifier})
  `;
}

/**
 * Normalise a control-session row's `int8` columns to numbers.
 *
 * Shared for the same reason as the SQL: this coercion was duplicated logic, and dropping or
 * changing it on one side alone would red nothing until a token actually expired on the lane.
 */
export function mapControlSessionRow(row: ControlSessionAuthRow) {
  return {
    tenantId: row.tenantId,
    userId: row.userId,
    sessionId: row.sessionId,
    expiresAt: Number(row.expiresAt),
    revokedAt: row.revokedAt === null ? null : Number(row.revokedAt),
  };
}
