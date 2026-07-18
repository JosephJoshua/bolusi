// The client directory / attempt-state DB seam (10-db §9.5).
//
// Platform-free by the same technique as authz/directory.ts: raw `sql` over the verbatim snake_case
// DDL, generic in `DB`, so core keeps its "kysely types + @bolusi/schemas only" boundary (08 §3.3)
// and the loader works whether or not the caller installed `CamelCasePlugin`. These tables are
// written ONLY from the enrollment bundle / bundle refreshes / local PIN writes — NEVER from ops
// (01-domain-model §1); the permission evaluator and the switcher read them.
import { sql, type Kysely } from 'kysely';

import { TENANT_ID_META_KEY } from '../authz/directory.js';
import type { CanonicalRef, PinVerifier } from './verifier.js';

/** A `pin_attempt_state` row (10-db §9.5; api/02-auth §6.5). Absent ⇒ a clean slate (no failures). */
export interface PinAttemptRow {
  readonly userId: string;
  readonly deviceId: string;
  readonly consecutiveFailures: number;
  /** ms epoch of the first failure in the current streak; null when there is no streak. */
  readonly windowStartedAt: number | null;
  /** ms epoch before which the next attempt is refused unevaluated; null when unthrottled. */
  readonly notBefore: number | null;
}

/** A `users_directory` row (10-db §9.5). */
export interface DirectoryUserRow {
  readonly id: string;
  readonly name: string;
  readonly photoMediaId: string | null;
  readonly status: 'active' | 'deactivated';
}

/** A `roles_directory` row (10-db §9.5). */
export interface DirectoryRoleRow {
  readonly id: string;
  readonly name: string;
  readonly scopeType: 'tenant' | 'store';
  readonly isSystemDefault: boolean;
  readonly permissionIds: readonly string[];
}

/** A `user_roles_directory` row — the `UserRoleGrant` tuple (10-db §9.5). */
export interface DirectoryGrantRow {
  readonly userId: string;
  readonly roleId: string;
  readonly storeId: string | null;
}

// ── meta_kv (device identity) ──────────────────────────────────────────────────────────────────

/**
 * `meta_kv` key holding the device's own id (10-db §9.1 names it; api/02-auth §4.1). Written once
 * by enrollment (enrollment.ts) — the id the sync loop speaks for (`SyncLoopOptions.deviceId`).
 */
export const DEVICE_ID_META_KEY = 'deviceId';

/**
 * `meta_kv` key holding the device's bound store id (10-db §9.1 names it). Written once by
 * enrollment from the ENROLL RESPONSE, never by `applyBundle`: §7.4's store binding is irreversible,
 * and a bundle refresh must not be able to silently re-bind the device's store (bundle-apply.ts).
 */
export const STORE_ID_META_KEY = 'storeId';

/** Read the device's tenant id from `meta_kv` (10-db §9.1), or null when unbootstrapped. */
export async function readTenantId<DB>(db: Kysely<DB>): Promise<string | null> {
  const rows = await sql<{ value: string }>`
    SELECT value FROM meta_kv WHERE key = ${TENANT_ID_META_KEY}
  `.execute(db);
  return rows.rows[0]?.value ?? null;
}

/**
 * Read the device's own id from `meta_kv` (10-db §9.1), or null when the device is not yet enrolled
 * — the boot signal that gates the sync loop (task 89). Mirrors `readTenantId` (§2.8: one accessor
 * pattern, not a fourth); a null answer is the true "unenrolled" state, never a default.
 */
export async function readDeviceId<DB>(db: Kysely<DB>): Promise<string | null> {
  return readMeta(db, DEVICE_ID_META_KEY);
}

/** Read the device's bound store id from `meta_kv` (10-db §9.1), or null when unenrolled. */
export async function readStoreId<DB>(db: Kysely<DB>): Promise<string | null> {
  return readMeta(db, STORE_ID_META_KEY);
}

/** Read a `meta_kv` value by key (10-db §9.1), or null. */
export async function readMeta<DB>(db: Kysely<DB>, key: string): Promise<string | null> {
  const rows = await sql<{ value: string }>`
    SELECT value FROM meta_kv WHERE key = ${key}
  `.execute(db);
  return rows.rows[0]?.value ?? null;
}

/** Upsert a `meta_kv` entry (10-db §9.1). */
export async function writeMeta<DB>(db: Kysely<DB>, key: string, value: string): Promise<void> {
  await sql`
    INSERT INTO meta_kv (key, value) VALUES (${key}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `.execute(db);
}

/** Delete a `meta_kv` entry (10-db §9.1). */
export async function deleteMeta<DB>(db: Kysely<DB>, key: string): Promise<void> {
  await sql`DELETE FROM meta_kv WHERE key = ${key}`.execute(db);
}

/** Does this device already have its genesis op (seq 1)? — the enrollment idempotency backstop. */
export async function deviceHasGenesis<DB>(db: Kysely<DB>, deviceId: string): Promise<boolean> {
  const rows = await sql<{ one: number }>`
    SELECT 1 AS one FROM operations WHERE device_id = ${deviceId} AND seq = 1 LIMIT 1
  `.execute(db);
  return rows.rows.length > 0;
}

// ── directory mirrors (wholesale replace on bundle refresh, api/02-auth §5.2) ─────────────────────

/** Replace `users_directory` wholesale (api/02-auth §5.2 — the mirror is overwritten, not merged). */
export async function replaceUsersDirectory<DB>(
  db: Kysely<DB>,
  users: readonly DirectoryUserRow[],
): Promise<void> {
  await sql`DELETE FROM users_directory`.execute(db);
  for (const u of users) {
    await sql`
      INSERT INTO users_directory (id, name, photo_media_id, status)
      VALUES (${u.id}, ${u.name}, ${u.photoMediaId}, ${u.status})
    `.execute(db);
  }
}

/** Replace `roles_directory` wholesale. `permissionIds` is stored as a JSON array (10-db §9.5). */
export async function replaceRolesDirectory<DB>(
  db: Kysely<DB>,
  roles: readonly DirectoryRoleRow[],
): Promise<void> {
  await sql`DELETE FROM roles_directory`.execute(db);
  for (const r of roles) {
    await sql`
      INSERT INTO roles_directory (id, name, scope_type, is_system_default, permission_ids)
      VALUES (${r.id}, ${r.name}, ${r.scopeType}, ${r.isSystemDefault ? 1 : 0}, ${JSON.stringify(r.permissionIds)})
    `.execute(db);
  }
}

/**
 * Replace `user_roles_directory` wholesale with the bundle's grant tuples, written VERBATIM
 * (api/02-auth §5.2 — the evaluator reads the tuples as-is).
 */
export async function replaceUserRolesDirectory<DB>(
  db: Kysely<DB>,
  grants: readonly DirectoryGrantRow[],
): Promise<void> {
  await sql`DELETE FROM user_roles_directory`.execute(db);
  for (const g of grants) {
    await sql`
      INSERT INTO user_roles_directory (user_id, role_id, store_id)
      VALUES (${g.userId}, ${g.roleId}, ${g.storeId})
    `.execute(db);
  }
}

// ── user_pin_verifiers (bundle + local write; greatest-asOf merge, api/02-auth §5.3) ──────────────

/**
 * The `user_pin_verifiers.params` JSON shape (client-owned; §5.3 self-describing params).
 *
 * `p` is typed `number`, not the `1` a legitimately-written row carries: `readVerifier` reads it back
 * VERBATIM so a tampered `p` is visible to the verify-path bounds check (SEC-AUTH-01), not silently
 * narrowed to `1` by this cast — a check cannot reject a value the read just invented (T-13).
 */
interface StoredParams {
  readonly mKiB: number;
  readonly t: number;
  readonly p: number;
}

/** Read a user's stored verifier, or null. Reconstructs the self-describing `PinVerifier` (§5.3). */
export async function readVerifier<DB>(
  db: Kysely<DB>,
  userId: string,
): Promise<PinVerifier | null> {
  const rows = await sql<{
    algo: string;
    salt: string;
    params: string;
    hash: string;
    asOfTimestamp: number;
    asOfDeviceId: string;
    asOfSeq: number;
  }>`
    SELECT algo, salt, params, hash,
           as_of_timestamp AS "asOfTimestamp",
           as_of_device_id AS "asOfDeviceId",
           as_of_seq AS "asOfSeq"
    FROM user_pin_verifiers WHERE user_id = ${userId}
  `.execute(db);
  const row = rows.rows[0];
  if (row === undefined) return null;
  const params = JSON.parse(row.params) as StoredParams;
  // Reconstruct from the stored bytes VERBATIM — `algo` and `p` are read back as-is (not hardcoded to
  // `'argon2id'`/`1`), so a tampered local row is VISIBLE to the caller's bounds check rather than
  // normalized away before it can be seen (SEC-AUTH-01, T-13). readVerifier does not itself gate: the
  // verify path re-checks (pin-verify.ts, mirroring the bundle path at bundle-apply.ts), and callers
  // that only compare `asOf` (bundle-apply merge) never touch these fields.
  return {
    algorithm: row.algo as PinVerifier['algorithm'],
    saltB64: row.salt,
    mKiB: params.mKiB,
    t: params.t,
    p: params.p as PinVerifier['p'],
    hashB64: row.hash,
    asOf: {
      timestamp: Number(row.asOfTimestamp),
      deviceId: row.asOfDeviceId,
      seq: Number(row.asOfSeq),
    },
  };
}

/** Upsert a user's verifier row (§5.3). Overwrites unconditionally — callers apply the merge rule. */
export async function writeVerifier<DB>(
  db: Kysely<DB>,
  userId: string,
  verifier: PinVerifier,
): Promise<void> {
  const params: StoredParams = { mKiB: verifier.mKiB, t: verifier.t, p: 1 };
  await sql`
    INSERT INTO user_pin_verifiers
      (user_id, algo, salt, params, hash, as_of_timestamp, as_of_device_id, as_of_seq)
    VALUES (${userId}, ${verifier.algorithm}, ${verifier.saltB64}, ${JSON.stringify(params)},
            ${verifier.hashB64}, ${verifier.asOf.timestamp}, ${verifier.asOf.deviceId}, ${verifier.asOf.seq})
    ON CONFLICT (user_id) DO UPDATE SET
      algo = excluded.algo, salt = excluded.salt, params = excluded.params, hash = excluded.hash,
      as_of_timestamp = excluded.as_of_timestamp,
      as_of_device_id = excluded.as_of_device_id,
      as_of_seq = excluded.as_of_seq
  `.execute(db);
}

/** Delete a user's verifier row — the bundle no longer carries one (deactivation / unassignment). */
export async function deleteVerifier<DB>(db: Kysely<DB>, userId: string): Promise<void> {
  await sql`DELETE FROM user_pin_verifiers WHERE user_id = ${userId}`.execute(db);
}

/** Every user id with a stored verifier — the denominator for a wholesale verifier refresh. */
export async function verifierUserIds<DB>(db: Kysely<DB>): Promise<string[]> {
  const rows = await sql<{ userId: string }>`
    SELECT user_id AS "userId" FROM user_pin_verifiers
  `.execute(db);
  return rows.rows.map((r) => r.userId);
}

// ── pin_attempt_state (api/02-auth §6.5) ──────────────────────────────────────────────────────────

/** Read a `(userId, deviceId)` attempt row, or null when the pair has never failed. */
export async function readPinAttempt<DB>(
  db: Kysely<DB>,
  userId: string,
  deviceId: string,
): Promise<PinAttemptRow | null> {
  const rows = await sql<{
    consecutiveFailures: number;
    windowStartedAt: number | null;
    notBefore: number | null;
  }>`
    SELECT consecutive_failures AS "consecutiveFailures",
           window_started_at AS "windowStartedAt",
           not_before AS "notBefore"
    FROM pin_attempt_state WHERE user_id = ${userId} AND device_id = ${deviceId}
  `.execute(db);
  const row = rows.rows[0];
  if (row === undefined) return null;
  return {
    userId,
    deviceId,
    consecutiveFailures: Number(row.consecutiveFailures),
    windowStartedAt: row.windowStartedAt === null ? null : Number(row.windowStartedAt),
    notBefore: row.notBefore === null ? null : Number(row.notBefore),
  };
}

/** Upsert the `(userId, deviceId)` attempt row (10-db §9.5). */
export async function writePinAttempt<DB>(db: Kysely<DB>, row: PinAttemptRow): Promise<void> {
  await sql`
    INSERT INTO pin_attempt_state
      (user_id, device_id, consecutive_failures, window_started_at, not_before)
    VALUES (${row.userId}, ${row.deviceId}, ${row.consecutiveFailures}, ${row.windowStartedAt}, ${row.notBefore})
    ON CONFLICT (user_id, device_id) DO UPDATE SET
      consecutive_failures = excluded.consecutive_failures,
      window_started_at = excluded.window_started_at,
      not_before = excluded.not_before
  `.execute(db);
}

// ── directory membership / role checks (targeting restrictions, 02-permissions §5.4.6, §6.6) ──────

/** Is `userId` present in `users_directory` (a reset/unlock target must be — §5.4.6 rule 6)? */
export async function userInDirectory<DB>(db: Kysely<DB>, userId: string): Promise<boolean> {
  const rows = await sql<{ one: number }>`
    SELECT 1 AS one FROM users_directory WHERE id = ${userId} LIMIT 1
  `.execute(db);
  return rows.rows.length > 0;
}

/**
 * Does `userId` hold the `main_owner` role (api/02-auth §6.6 privileged-target rule)?
 *
 * The client identifies "the main_owner role" structurally, without a hardcoded id: it is the ONLY
 * tenant-scoped system-default role (02-permissions §10), so holding it means holding a tenant-wide
 * grant (`store_id IS NULL`) to a role that is `scope_type='tenant'` AND `is_system_default`. This
 * is the client arm; the server push-validates the same rule against its directory (§6.3).
 */
export async function holdsMainOwnerRole<DB>(db: Kysely<DB>, userId: string): Promise<boolean> {
  const rows = await sql<{ one: number }>`
    SELECT 1 AS one
    FROM user_roles_directory urd
    JOIN roles_directory rd ON rd.id = urd.role_id
    WHERE urd.user_id = ${userId}
      AND urd.store_id IS NULL
      AND rd.scope_type = 'tenant'
      AND rd.is_system_default = 1
    LIMIT 1
  `.execute(db);
  return rows.rows.length > 0;
}

/** A `CanonicalRef` for a device-computed verifier from the emitting op's canonical position. */
export function refFromOp(op: {
  readonly timestamp: number;
  readonly deviceId: string;
  readonly seq: number;
}): CanonicalRef {
  return { timestamp: op.timestamp, deviceId: op.deviceId, seq: op.seq };
}

// ── switcher usability (api/02-auth §5.1, 03-state-machines §6) ────────────────────────────────────

/**
 * The switcher-usable users: only `active` ones (api/02-auth §5.1). A deactivated user stays in
 * `users_directory` (their name renders on historical ops) but is excluded here — authentication is
 * gated on status; name resolution is not.
 */
export async function listSwitcherUsers<DB>(
  db: Kysely<DB>,
): Promise<{ id: string; name: string; photoMediaId: string | null }[]> {
  const rows = await sql<{ id: string; name: string; photoMediaId: string | null }>`
    SELECT id, name, photo_media_id AS "photoMediaId"
    FROM users_directory WHERE status = 'active' ORDER BY name
  `.execute(db);
  return rows.rows.map((r) => ({ id: r.id, name: r.name, photoMediaId: r.photoMediaId }));
}

/** Resolve ANY user's display name from the directory — including a deactivated one (for history). */
export async function resolveUserName<DB>(db: Kysely<DB>, userId: string): Promise<string | null> {
  const rows = await sql<{ name: string }>`
    SELECT name FROM users_directory WHERE id = ${userId}
  `.execute(db);
  return rows.rows[0]?.name ?? null;
}
