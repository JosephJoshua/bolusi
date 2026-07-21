// The DB shape the platform module's appliers and queries are typed against (04 §2).
//
// ── WHY THIS INTERFACE EXISTS AT ALL ──────────────────────────────────────────────────────────
//
// 01 §7: "Projection tables exist twice with one applier: Postgres (server read models) and SQLite
// (device read models), written via the dialect-neutral `ProjectionDb` subset." The two physical
// schemas are DIFFERENT TypeScript types — db-server's generated `DB` (where `bigint` columns are
// `Int8 = ColumnType<string, …>`) and db-client's `ClientDatabase`. An applier typed against either
// one could only run on that engine, which is precisely the per-engine copy §2.8 forbids.
//
// So the appliers are typed against THIS neutral shape: the columns 10-db declares for the two
// platform tables, named as Kysely's `CamelCasePlugin` maps them, with the JS types both engines
// agree on. The module is cast to the concrete `DB` once, at each registration site.
//
// ── THE CAMEL-CASE TRAP, LIVE IN THIS FILE ────────────────────────────────────────────────────
//
// 10-db §11 is explicit that this schema's worst mapping bug lives in `conflicts`:
//
//   > `CamelCasePlugin` MUST be constructed with `{ underscoreBetweenUppercaseLetters: true }` on
//   > BOTH sides — the default options are wrong for this schema. … codegen turns the column
//   > `op_a_id` into the property `opAId`, but default `snakeCase('opAId')` is `'op_aid'`, a column
//   > that does not exist. Such a query *typechecks* and fails at runtime with "no such column".
//   > The trigger is a single-letter segment between camel humps — **live today in
//   > `conflicts.op_a_id` / `op_b_id`**.
//
// `opAId`/`opBId` below ARE that case. Nothing in this file can prevent a consumer from
// constructing the plugin with default options; what makes it survivable is that the failure is
// LOUD ("no such column") rather than silent, and that both the client and server connection
// helpers centralize the option (`CLIENT_CAMEL_CASE_OPTIONS`, db-server's `camel-case.ts`).

/**
 * A `conflicts` row (01 §5.4; DDL 10-db §8 Postgres / §9.6 SQLite).
 *
 * Column order below is 10-db's DDL order, which is also the manifest's declaration order and
 * therefore the order the convergence oracle digests (testing-guide §3.4). Keep them in step.
 */
export interface ConflictsTable {
  /** = the detection op's `entityId` (01 §5.4). */
  id: string;
  tenantId: string;
  /** The conflicted entity's store; null for tenant-scoped entities (01 §5.4). */
  storeId: string | null;
  entityType: string;
  entityId: string;
  /** Which aspect collided — the op type's declared `conflict.key` (01 §8.1). */
  conflictKey: string;
  /** `minor | significant` — CHECK-constrained on both engines. */
  severity: string;
  /** `detected | auto_resolved | surfaced | acknowledged` — CHECK-constrained on both engines. */
  status: string;
  /** The colliding ops in canonical order (A before B) — 01 §5.4. */
  opAId: string;
  opBId: string;
  /** Server time of detection, ms epoch (`bigint`/`INTEGER`). */
  detectedAt: number;
  acknowledgedBy: string | null;
  acknowledgedAt: number | null;
  acknowledgementOpId: string | null;
}

/**
 * A `user_prefs` row (07-i18n §1.1; DDL 10-db §8 / §9.6).
 *
 * `locale` holds a `Locale` — `'id' | 'en'` in v0 — because 07-i18n §1.1 pins the payload to
 * `z.enum(['id','en'])` and the applier writes exactly what the payload carries. It is NOT an Intl
 * formatting tag: `'id-ID'` is `INTL_LOCALE_TAG.id`, a region tag 07-i18n §5 keeps separate from the
 * locale. Both engines once declared `locale text NOT NULL DEFAULT 'id-ID'`; task 76 dropped that
 * default (server migration 0009; client `001-initial-schema`; 10-db §8/§9.6). It was unreachable
 * through the fold — the applier always supplies `locale` — so a column default was inert AND a
 * decoy pointing at the wrong vocabulary. The read-side fallback ("default `id` when the row is
 * absent") belongs to the reader (`resolveLocale`), which a column default cannot express. The
 * column stays NOT NULL because every insert (the applier) supplies the value.
 */
export interface UserPrefsTable {
  /** = the op's `entityId` = the acting user (07-i18n §1.1). */
  userId: string;
  tenantId: string;
  /** A `Locale` — `'id' | 'en'` in v0. See the note above. */
  locale: string;
  /** ms epoch (`bigint`/`INTEGER`). */
  updatedAt: number;
}

/** The two v0 platform projection tables (01 §7). */
export interface PlatformDatabase {
  conflicts: ConflictsTable;
  userPrefs: UserPrefsTable;
}
