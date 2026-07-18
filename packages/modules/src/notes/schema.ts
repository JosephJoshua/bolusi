// The dialect-neutral DB shape the `notes` appliers and queries are typed against (04 §2).
//
// 01 §7: "Projection tables exist twice with one applier: Postgres (server read models) and SQLite
// (device read models), written via the dialect-neutral `ProjectionDb` subset." The two physical
// schemas are DIFFERENT TypeScript types — db-server's generated `DB` (where `archived` is
// `Generated<boolean>` and `bigint` columns are `Int8 = ColumnType<string, …>`) and db-client's
// `ClientDatabase` (`archived: Generated<number>`). An applier typed against either could only run
// on that engine — the per-engine copy §2.8 forbids. So it is typed against THIS neutral shape,
// with the JS types both engines agree on, and cast to the concrete `DB` once at each registration
// site (SERVER_MODULES / CLIENT_MODULES), exactly as the platform module is.
//
// ── WHY `archived` IS `number`, NOT `boolean` ─────────────────────────────────────────────────
//
// 10-db declares `archived boolean` on Postgres and `archived INTEGER` on SQLite. op-sqlite (the
// device driver) is non-conformant and REFUSES a JS boolean bind (db-client/driver.ts: "Store
// booleans as INTEGER 0/1"), so an applier writing `true`/`false` would throw on device. Writing
// `0`/`1` works on BOTH: SQLite stores the integer; Postgres coerces `1`/`0` to `true`/`false` on
// insert (verified against PGlite and real PG16). So the applier writes `0 | 1`, this column is
// `number`, and the manifest declares its logical type `'boolean'` — which is what makes the
// convergence oracle normalize SQLite's `0/1` and Postgres's `true/false` to the same digest byte
// (testing-guide §3.4).

/**
 * A `notes` row (01 §9; DDL 10-db §8 Postgres / §9.6 SQLite).
 *
 * Column order below is 10-db's DDL order, which is also the manifest's declaration order and
 * therefore the order the convergence oracle digests (testing-guide §3.4). Keep them in step.
 */
export interface NotesTable {
  /** = the op's `entityId` (01 §9). */
  id: string;
  tenantId: string;
  /** Store-scoped: a note belongs to one store, non-null (01 §9). */
  storeId: string;
  /** Set at creation; v0 has no title edit (01 §9). */
  title: string;
  /** Last body in canonical order (LWW — the engine guarantees order, §4.2). */
  body: string;
  /** One attachment; null for v1 notes and v2 notes with no media (01 §9). */
  mediaId: string | null;
  /** `0 | 1` — logical `'boolean'` in the manifest. See the header for why it is not `boolean`. */
  archived: number;
  /** +1 per applied `note_body_edited` (01 §9 testability column; testing-guide §3.2). */
  editCount: number;
  createdBy: string;
  /** ms epoch. */
  createdAt: number;
  lastEditedBy: string;
  /** ms epoch. */
  lastEditedAt: number;
}

/** The one v0 `notes` projection table (01 §9). */
export interface NotesDatabase {
  notes: NotesTable;
}
