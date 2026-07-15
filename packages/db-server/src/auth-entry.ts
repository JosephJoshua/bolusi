// 10-db-schema §6.4 (D14) — the ONLY cross-tenant read path in @bolusi/db-server.
//
// Token verification (every request) and login must resolve the tenant FROM an opaque credential
// — a bdt_/bcs_ bearer token, or a globally-unique loginIdentifier — BEFORE the tenant is known,
// which forTenant cannot express (it requires the tenant and scopes RLS to it). These three
// functions are the narrow, sanctioned exception: each invokes a SECURITY DEFINER SQL function
// (owner bolusi_auth, BYPASSRLS) whose fixed body does ONE keyed lookup and returns the minimal
// fields of the single matched row, nothing on no-match (fail closed). The connecting role stays
// NOBYPASSRLS and can read no byte beyond what the function body returns — an arbitrary
// cross-tenant SELECT on these tables still fails closed (auth-entry.test.ts proves it).
//
// This module holds getDb (internal) but exposes only these fixed lookups — it is NOT a raw
// handle, and there is no way through it to run an arbitrary cross-tenant query.
import { sql } from 'kysely';

import { getDb } from './db.js';

/** Minimal device auth row for `verifyToken` (bdt_) — api/02-auth §8. */
export interface DeviceAuthRecord {
  readonly tenantId: string;
  readonly storeId: string | null;
  readonly deviceId: string;
  /** Device.status — 'active' | 'revoked' (03-state-machines §5). */
  readonly status: string;
}

/** Minimal control-session auth row for `verifyToken` (bcs_) — api/02-auth §8. */
export interface ControlSessionAuthRecord {
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionId: string;
  /** ms-epoch expiry. */
  readonly expiresAt: number;
  /** ms-epoch revocation, or null. */
  readonly revokedAt: number | null;
}

/** Minimal login credential row for `POST /v1/auth/login` — api/02-auth §4.2. */
export interface LoginCredentialRecord {
  readonly tenantId: string;
  readonly userId: string;
  /** argon2id verifier JSON, or null (PIN-only user — login still runs the dummy KDF). */
  readonly passwordVerifier: string | null;
  /** User.status — 'active' | 'deactivated'. */
  readonly status: string;
}

/** Resolve a device by its SHA-256 token hash (hex). Cross-tenant, definer-gated. */
export async function findDeviceByTokenHash(
  tokenHashHex: string,
): Promise<DeviceAuthRecord | undefined> {
  const { rows } = await sql<{
    tenantId: string;
    storeId: string | null;
    deviceId: string;
    status: string;
  }>`
    SELECT tenant_id AS "tenantId", store_id AS "storeId", device_id AS "deviceId", status
      FROM auth_find_device_by_token_hash(${tokenHashHex})
  `.execute(getDb());
  return rows[0];
}

/** Resolve a control session by its SHA-256 token hash (hex). Cross-tenant, definer-gated. */
export async function findControlSessionByTokenHash(
  tokenHashHex: string,
): Promise<ControlSessionAuthRecord | undefined> {
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
  `.execute(getDb());
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    tenantId: row.tenantId,
    userId: row.userId,
    sessionId: row.sessionId,
    expiresAt: Number(row.expiresAt),
    revokedAt: row.revokedAt === null ? null : Number(row.revokedAt),
  };
}

/** Resolve a user by globally-unique loginIdentifier. Cross-tenant, definer-gated. */
export async function findLoginCredential(
  loginIdentifier: string,
): Promise<LoginCredentialRecord | undefined> {
  const { rows } = await sql<{
    tenantId: string;
    userId: string;
    passwordVerifier: string | null;
    status: string;
  }>`
    SELECT tenant_id AS "tenantId", user_id AS "userId",
           password_verifier AS "passwordVerifier", status
      FROM auth_find_login_credential(${loginIdentifier})
  `.execute(getDb());
  return rows[0];
}
