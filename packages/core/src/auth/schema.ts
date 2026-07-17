// The DB shape the `auth` module's appliers and queries are typed against (04 §2).
//
// ── WHY THIS INTERFACE EXISTS (mirrors platform/schema.ts) ─────────────────────────────────────
//
// 01 §7: "Projection tables exist twice with one applier: Postgres (server read models) and SQLite
// (device read models), written via the dialect-neutral `ProjectionDb` subset." The two physical
// schemas are DIFFERENT TypeScript types — db-server's generated `DB` (where `bigint` columns are
// `Int8 = ColumnType<string, …>`) and db-client's `ClientDatabase`. An applier typed against either
// one could only run on that engine, which is precisely the per-engine copy §2.8 forbids.
//
// So the appliers are typed against THIS neutral shape: the columns 10-db §549+ declares for the
// three auth projection tables, named as Kysely's `CamelCasePlugin` maps them, with the JS types
// both engines agree on (ms-epoch/count columns are `number`, not `bigint`). The module is cast to
// the concrete `DB` once, at each registration site (deps.ts / the client bootstrap).

/**
 * An `auth_sessions` row (api/02-auth §6.2; DDL 10-db §549+). The PRD-011 §5 UserSession record.
 *
 * Column order below is 10-db's DDL order, which is also the manifest's declaration order and
 * therefore the order the convergence oracle digests (testing-guide §3.4). Keep them in step.
 *
 * `id` = the SESSION's `entityId` (the `auth.user_switched` op's `entityId`), NOT the op id: a
 * session is one entity written by two ops (`user_switched` inserts it, `session_ended` closes it),
 * both carrying the SAME `entityId`. Keying the row by that id is what lets `session_ended` find the
 * row `user_switched` created, and what makes the §4.2 re-fold delete-by-`entityId` correct.
 */
export interface AuthSessionsTable {
  /** = the session's `entityId` (10-db §549+). */
  id: string;
  tenantId: string;
  /** The emitting device's store (all auth ops are store-scoped, api/02-auth §6.2). */
  storeId: string | null;
  /** The session's user — the INCOMING user of the switch (api/02-auth §6.3). */
  userId: string;
  deviceId: string;
  /** ms epoch (`bigint`/`INTEGER`) — the `user_switched` op's timestamp. */
  startedAt: number;
  /** NULL while the session is open; set by `auth.session_ended`. */
  endedAt: number | null;
  /** `switch | idle_lock | manual_lock` (api/02-auth §6.2), or NULL while open. */
  endReason: string | null;
}

/**
 * A `pin_lockout_events` row (api/02-auth §6.2/§6.5; DDL 10-db §549+). Append-only, owner-visible
 * brute-force evidence — one row per `auth.pin_locked_out` / `auth.pin_lockout_cleared` op.
 *
 * `id` = the OP id (unique per event). The ENTITY is `user_credential`/`userId` (the targeted
 * user), so multiple events share `(entityType, entityId)`; `userId` is the re-fold's delete key,
 * `id` is the append-only primary key. That is why `id` and `userId` are different columns here and
 * the same column in `auth_sessions`.
 */
export interface PinLockoutEventsTable {
  /** = the op id (10-db §549+). */
  id: string;
  tenantId: string;
  storeId: string | null;
  /** The TARGETED user = the op's `entityId` (10-db §549+ comment). */
  userId: string;
  /** From the envelope (10-db §549+ comment) — the device the lockout happened on. */
  deviceId: string;
  /** `pin_locked_out | pin_lockout_cleared` — CHECK-constrained on both engines. */
  kind: string;
  /** `consecutiveFailures` for a lockout; NULL for a cleared event (10-db §549+). */
  failureCount: number | null;
  /** ms epoch (`bigint`/`INTEGER`) — the op's timestamp. */
  at: number;
}

/**
 * An `auth_permission_denials` row (02-permissions §7; DDL 10-db §549+). The FR-1045 audit trail:
 * one row per `auth.permission_denied` op.
 *
 * `id` = the DENIAL's `entityId` (02-permissions §7: "`permission_denial` / fresh UUIDv7 per op …
 * applier inserts exactly one row"). Each denial is its own single-op entity, so `entityId` is a
 * unique, re-fold-safe primary key and `entityIdColumn: 'id'` is an HONEST statement of "the column
 * the §4.2 re-fold deletes by" — see permission-denials.ts for why this is `entityId`, not `op.id`.
 */
export interface AuthPermissionDenialsTable {
  /** = the denial op's `entityId` (see the header). */
  id: string;
  tenantId: string;
  /** The envelope's device store (02-permissions §7). */
  storeId: string | null;
  /** The EVALUATION scope from the payload — NULL for a tenant-scope check (02-permissions §7). */
  scopeStoreId: string | null;
  userId: string;
  deviceId: string;
  /** ms epoch (`bigint`/`INTEGER`). */
  timestampMs: number;
  permissionId: string;
  /** `command | query` (02-permissions §7). */
  surface: string;
  /** The denied command/query name, or NULL. */
  target: string | null;
  /** A `DenialReason` (02-permissions §7, closed set). */
  reason: string;
  /** Repeats suppressed by the §7 throttle since the previous emission; `0` on a first denial. */
  suppressedRepeats: number;
}

/**
 * The three v0 auth projection tables (api/02-auth §6.2; 10-db §549+).
 *
 * Keys are CAMEL-CASE — the identifiers Kysely's `CamelCasePlugin` maps to/from the physical
 * snake_case names, exactly as `PlatformDatabase.userPrefs` does for `user_prefs`. The MANIFEST
 * (`module.ts`) keys its `projections.tables` by the PHYSICAL names instead, because the engine's
 * §4.2 re-fold reaches them through raw `sql.table(...)` which does not run the plugin.
 */
export interface AuthDatabase {
  authSessions: AuthSessionsTable;
  pinLockoutEvents: PinLockoutEventsTable;
  authPermissionDenials: AuthPermissionDenialsTable;
}
