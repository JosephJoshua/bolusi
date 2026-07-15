// Directory snapshot (02-permissions §6, 01-domain-model §4, 10-db-schema §9.5): the in-memory
// copy of the client directory mirrors the evaluator reads.
//
// WHY A SNAPSHOT AT ALL. `hasPermission` is SYNCHRONOUS (§6) — it runs on every command and every
// query, and a check nobody can afford is a check someone caches ad hoc, badly (NFR-1002). Kysely
// is async, so the rows are lifted into memory ONCE and evaluated from there. The snapshot is the
// memo (memo.ts): it goes stale on purpose and is dropped only by an event (§6), never by a timer.
//
// WHAT FEEDS IT. The mirrors are written ONLY by the enrollment bundle and conditional bundle
// refreshes (api/02-auth §5) — NEVER from ops (01-domain-model §1). The bootstrap rule guarantees
// the bundle lands before the first command runs, so the evaluator always has rows to read.
//
// TENANT ON THE CLIENT. The device DB is single-tenant: the mirrors carry no `tenant_id` column
// and the tenant lives in `meta_kv` (10-db §9.5). §5.2 step 2's `user.tenantId === tenantId` is
// therefore realized here as "the device's tenant === the evaluation tenant" — every mirror row
// belongs to the device's tenant by construction. A missing `meta_kv` tenant yields `tenantId:
// null`, which matches no evaluation tenant and so denies (fail closed, §5.3).
//
// Platform-free: raw `sql` over the verbatim snake_case DDL, so the loader is generic in `DB` and
// core keeps its "kysely types + @bolusi/schemas only" boundary (08 §3.3) — the same approach the
// projection engine takes for its schema-independent reads.
import { sql, type Kysely } from 'kysely';

/** `meta_kv` key holding the device's tenant id (10-db §9.1). */
export const TENANT_ID_META_KEY = 'tenantId';

/** A `users_directory` row, authz-relevant columns only (10-db §9.5). */
export interface DirectoryUser {
  /** `active | deactivated` (01-domain-model §4.1). Compared as a string: any non-`active`
   *  value — including one this build does not know — denies (§5.3). */
  readonly status: string;
}

/** A `roles_directory` row, authz-relevant columns only (10-db §9.5). */
export interface DirectoryRole {
  /** `tenant | store` (01-domain-model §4.2). */
  readonly scopeType: string;
  /**
   * The role's `permissionIds` as the RAW JSON text stored in `roles_directory.permission_ids`.
   *
   * Deliberately unparsed: parsing at load time would make one corrupt row poison the whole
   * snapshot load (and every user's evaluation, including users who do not hold that role).
   * Parsed lazily inside the evaluator's try/catch, a corrupt row denies `evaluation_error` for
   * exactly the evaluations that actually read it (§5.2 step 7).
   */
  readonly permissionIdsJson: string;
}

/** A `user_roles_directory` row — the `UserRoleGrant` tuple (§5.1, 01-domain-model §4.3). */
export interface DirectoryGrant {
  readonly roleId: string;
  /** `null` ⇔ tenant-wide grant, valid ONLY for roles with `scopeType: 'tenant'` (§5.1). */
  readonly storeId: string | null;
}

/**
 * An immutable in-memory copy of the directory slice this device holds (§6). Dropped and reloaded
 * by an invalidation event; never mutated in place.
 */
export interface DirectorySnapshot {
  /** The device's tenant, from `meta_kv` — `null` when unbootstrapped (denies, see file header). */
  readonly tenantId: string | null;
  readonly users: ReadonlyMap<string, DirectoryUser>;
  readonly roles: ReadonlyMap<string, DirectoryRole>;
  readonly grantsByUser: ReadonlyMap<string, readonly DirectoryGrant[]>;
}

/** The seam the evaluator loads through — bound to Kysely in production, faked in L1 tests. */
export interface DirectorySource {
  load(): Promise<DirectorySnapshot>;
}

/** An empty snapshot: no users, no roles, no grants, no tenant. Every evaluation against it denies. */
export function emptyDirectorySnapshot(): DirectorySnapshot {
  return { tenantId: null, users: new Map(), roles: new Map(), grantsByUser: new Map() };
}

/**
 * Load the directory snapshot from the client mirrors (10-db §9.5).
 *
 * Columns are ALIASED to camelCase explicitly rather than relying on Kysely's `CamelCasePlugin`:
 * the plugin rewrites result keys only when it is installed, and core cannot know whether its
 * caller installed it. Aliasing produces the same keys either way.
 */
export async function loadDirectorySnapshot<DB>(db: Kysely<DB>): Promise<DirectorySnapshot> {
  const tenantRows = await sql<{ value: string }>`
    SELECT value FROM meta_kv WHERE key = ${TENANT_ID_META_KEY}
  `.execute(db);
  const tenantId = tenantRows.rows[0]?.value ?? null;

  const userRows = await sql<{ id: string; status: string }>`
    SELECT id, status FROM users_directory
  `.execute(db);
  const users = new Map<string, DirectoryUser>();
  for (const row of userRows.rows) {
    users.set(row.id, { status: row.status });
  }

  const roleRows = await sql<{ id: string; scopeType: string; permissionIds: string }>`
    SELECT id, scope_type AS "scopeType", permission_ids AS "permissionIds" FROM roles_directory
  `.execute(db);
  const roles = new Map<string, DirectoryRole>();
  for (const row of roleRows.rows) {
    roles.set(row.id, { scopeType: row.scopeType, permissionIdsJson: row.permissionIds });
  }

  const grantRows = await sql<{ userId: string; roleId: string; storeId: string | null }>`
    SELECT user_id AS "userId", role_id AS "roleId", store_id AS "storeId" FROM user_roles_directory
  `.execute(db);
  const grantsByUser = new Map<string, DirectoryGrant[]>();
  for (const row of grantRows.rows) {
    let list = grantsByUser.get(row.userId);
    if (list === undefined) {
      list = [];
      grantsByUser.set(row.userId, list);
    }
    list.push({ roleId: row.roleId, storeId: row.storeId });
  }

  return { tenantId, users, roles, grantsByUser };
}

/** A `DirectorySource` over a Kysely handle to the client DB (10-db §9.5). */
export function createDirectorySource<DB>(db: Kysely<DB>): DirectorySource {
  return { load: () => loadDirectorySnapshot(db) };
}
