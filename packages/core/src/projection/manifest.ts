// Projection manifest shape (04-module-contract §4.4) + the applier contract (§4.1).
//
// A module declares its projection tables (columns in DECLARATION ORDER — the oracle
// digests them in that order, testing-guide §3.4) and, per op type, the applier that folds
// an op into those tables. The projection ENGINE (engine.ts) owns order-independence
// (§4.2), watermarks (§4.3), rebuild, and the convergence oracle; an applier is ONLY a
// deterministic fold step and never sees out-of-order input.
//
// Platform-free: this file types the manifest over an injected `Kysely<DB>` handle
// (`ProjectionDb`, 04 §2) and imports only `kysely` types + `@bolusi/schemas` (08 §3.3).
import type { Kysely } from 'kysely';

import type { SignedOperation } from '@bolusi/schemas';

/**
 * A Kysely handle restricted to the dialect-neutral subset (04 §2). The engine is generic
 * over the concrete schema `DB` so a module's appliers keep their real column typing
 * (`Kysely<ClientDatabase>` on device, `Kysely<Database>` on the server) while the engine's
 * own generic operations (entity-row delete, oracle dump, op-log reads) go through raw `sql`
 * over the verbatim snake_case DDL (10-db §2) and never depend on `DB`.
 */
export type ProjectionDb<DB> = Kysely<DB>;

/**
 * The op an applier folds. It is the signed operation (05 §2.1–2.2) with its `payload`
 * decoded to an object — identical whether it arrived through the append seam (already an
 * object) or was reconstructed from the op log during a re-fold/rebuild (JSON-parsed). The
 * engine guarantees appliers see ops in canonical order (§4.2), so an applier never checks
 * arrival order itself.
 */
export type ProjectionOperation = SignedOperation;

/**
 * A fold step (04 §4.1): pure, deterministic, entity-scoped. It may write ONLY rows keyed
 * by the op's `(entityType, entityId)` (§4.1 rule 2) and must have no clock, randomness, or
 * I/O beyond `db`. Idempotent replay and ordering are the RUNTIME's job, never the applier's.
 */
export type ProjectionApplier<DB> = (
  db: ProjectionDb<DB>,
  op: ProjectionOperation,
) => void | Promise<void>;

/**
 * Logical column type (04 §4.4). Drives the oracle's per-scalar normalization (§3.4):
 *  - `text`    → JSON string
 *  - `integer` → JSON integer; magnitude > 2^53−1 → decimal string
 *  - `boolean` → 1 / 0 (SQLite stores 0/1, Postgres true/false — normalized to 1/0)
 *  - `blob`    → "0x" + lowercase hex
 * A non-integer numeric in any column is an oracle ERROR — floats are banned from
 * projections (05 §3), and the oracle enforces it (§3.4).
 */
export type ProjectionColumnType = 'text' | 'integer' | 'boolean' | 'blob';

/**
 * One projection table (04 §4.4). `columns` insertion order IS the declaration order the
 * oracle digests in — an object literal preserves string-key order, so authors write the
 * columns in 10-db DDL order. `entityType` + `entityIdColumn` are the `(entityType,
 * entityId) → rows` mapping §4.2 deletes by on a re-fold (judgment call — see engine.ts).
 */
export interface ProjectionTableManifest {
  /** Column → logical type, in DECLARATION ORDER (= 10-db DDL order). */
  readonly columns: Readonly<Record<string, ProjectionColumnType>>;
  /** Physical primary-key columns (10-db DDL). */
  readonly primaryKey: readonly string[];
  /**
   * The entity whose rows live in this table. The re-fold (§4.2) deletes this table's rows
   * for the affected `entityId`; multiple tables may share an `entityType` (a multi-table
   * entity), and the engine deletes all of them.
   */
  readonly entityType: string;
  /** Column holding the `entityId` — what the §4.2 re-fold deletes by. */
  readonly entityIdColumn: string;
  /** Bumping this forces a full rebuild on upgrade (04 §4.3–4.4). */
  readonly projectionVersion: number;
}

/**
 * The projection-facing view of a module manifest (04 §1/§4) the engine registers: the
 * module id (prefixes op types), its projection tables (§4.4), and the applier per op type
 * (§4.1). `defineModule` (task 11) produces the full manifest; this is the slice the
 * projection engine consumes, so the engine never depends on commands/queries/screens.
 */
export interface ModuleProjectionManifest<DB> {
  /** Lowercase module id (04 §1) — prefixes every op `type` it owns. */
  readonly id: string;
  /** Table name → manifest (§4.4). */
  readonly tables: Readonly<Record<string, ProjectionTableManifest>>;
  /** Op `type` → applier (§4.1). Every type this module folds appears here. */
  readonly appliers: Readonly<Record<string, ProjectionApplier<DB>>>;
}

/** Column names of a table in DECLARATION ORDER (the oracle's column list, §3.4). */
export function declaredColumns(table: ProjectionTableManifest): readonly string[] {
  return Object.keys(table.columns);
}

/**
 * A stable version signature for a module's projection: table → `projectionVersion`, in
 * table-name order. A change to ANY table's `projectionVersion` (or the table set) changes
 * the signature and forces a rebuild on next `rebuildIfVersionChanged` (04 §4.3).
 */
export function moduleVersionSignature<DB>(module: ModuleProjectionManifest<DB>): string {
  const entries = Object.keys(module.tables)
    .sort()
    .map((name) => [name, module.tables[name]?.projectionVersion ?? 0] as const);
  return JSON.stringify(entries);
}
