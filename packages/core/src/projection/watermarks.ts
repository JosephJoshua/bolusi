// Projection watermarks (04-module-contract §4.3).
//
//   applied_server_seq = highest CONTIGUOUS serverSeq applied from pull.
//   applied_local_seq  = highest local seq applied at append (own-device ops).
//
// Both are STRICTLY MONOTONIC and never decrease — not by pull, not by append, not by the
// entity-local re-fold (§4.2, which re-applies already-counted ops and so moves NEITHER), and
// not by a rebuild resume. Watermarks answer "is this projection caught up?", nothing else.
//
// This module owns the STORE PORT plus a client implementation over the `projection_watermarks`
// table (10-db §9.1, both columns). The port is the shape BOTH sides satisfy: the client here,
// and the server table (10-db §8, applied_server_seq only) when tasks 07/16 embed it — only the
// client shape is exercised now. The engine computes the advancement (contiguity via the op
// log — oplog-source `highestContiguousServerSeq`); the store only reads/persists the scalars.
//
// JUDGMENT CALL (04 §4.3 is terse): contiguity is evaluated over the GLOBAL serverSeq stream in
// the device's single-tenant op log (10-db §3: gapless per tenant), NOT the module-filtered
// subset — the engine reads `operations.server_seq` for presence, so a serverSeq belonging to
// another module still counts toward the contiguous prefix and never creates a phantom gap. A
// module's watermark is re-evaluated only when one of ITS ops is applied, so a module can lag
// the frontier until its next op; the sync loop (task 15) may additionally raise it. Recorded
// so nobody "fixes" the lag ad hoc.
import { sql, type Kysely } from 'kysely';

/** The two watermark scalars for a module (10-db §9.1). */
export interface WatermarkState {
  readonly appliedServerSeq: number;
  readonly appliedLocalSeq: number;
}

/**
 * Read + monotonic-advance the watermarks for a module. `advance*` raise the value to AT LEAST
 * the argument and never lower it — the "never decreases" invariant (§4.3) holds at the store,
 * independent of what the engine computes. The server implementation (task 16) satisfies the
 * same port; `advanceLocalSeq` is a no-op there (its table has no applied_local_seq column).
 */
export interface WatermarkStore {
  read(moduleId: string): Promise<WatermarkState>;
  advanceServerSeq(moduleId: string, value: number): Promise<void>;
  advanceLocalSeq(moduleId: string, value: number): Promise<void>;
}

/**
 * Watermark store over `projection_watermarks` (10-db §9.1). Dialect-neutral raw SQL: an upsert
 * whose `ON CONFLICT ... DO UPDATE` keeps the GREATER of (existing, proposed), so a lower value can
 * never regress the watermark even if a caller passes one (defense in depth for §4.3).
 *
 * ── WHY THE MAX IS A `CASE` AND NOT `MAX(a, b)` (task 11 — do not "simplify" this back) ────────
 *
 * `MAX(existing, proposed)` reads better and is SQLITE-ONLY. In SQLite `max()` with two arguments
 * is a scalar function; in PostgreSQL `max()` is an AGGREGATE and takes one argument, so the same
 * statement fails outright — and before it even gets that far, the bare `applied_server_seq` on the
 * right of `SET` is rejected as ambiguous, because Postgres requires the target table to be
 * qualified there. Postgres's scalar two-argument maximum is `GREATEST(a, b)`, which SQLite does
 * not have: there is no function spelled the same way on both engines, so the portable form is an
 * explicit `CASE`.
 *
 * This file previously carried the `MAX(a, b)` version under a docblock asserting it was
 * "dialect-neutral raw SQL". It was not, and nothing noticed, because the store is only exercised
 * against SQLite today — the server side (10-db §8) lands with tasks 07/16, which is exactly when a
 * claim nobody could run would have become a bug someone had to debug. Task 11's applier
 * conformance suite (T-8) runs the projection engine against BOTH engines and found it on its first
 * Postgres execution (`column reference "applied_local_seq" is ambiguous`).
 *
 * Both column references are table-qualified for the same reason: required by Postgres, accepted by
 * SQLite.
 */
export function createSqlWatermarkStore<DB>(db: Kysely<DB>): WatermarkStore {
  return {
    async read(moduleId: string): Promise<WatermarkState> {
      const result = await sql<{ appliedServerSeq: number; appliedLocalSeq: number }>`
        SELECT applied_server_seq, applied_local_seq
        FROM projection_watermarks WHERE module_id = ${moduleId}
      `.execute(db);
      const row = result.rows[0];
      // `Number(...)`: Postgres returns `bigint` as a STRING (int8 exceeds JS's safe integer range,
      // so the pg wire protocol will not silently narrow it), while SQLite returns a number. The
      // watermark is a seq that fits in a double for any plausible history, so normalizing here
      // keeps `WatermarkState` honest about being numbers on both engines — another divergence the
      // both-engine run surfaced.
      return {
        appliedServerSeq: row === undefined ? 0 : Number(row.appliedServerSeq ?? 0),
        appliedLocalSeq: row === undefined ? 0 : Number(row.appliedLocalSeq ?? 0),
      };
    },
    async advanceServerSeq(moduleId: string, value: number): Promise<void> {
      await sql`
        INSERT INTO projection_watermarks (module_id, applied_server_seq)
        VALUES (${moduleId}, ${value})
        ON CONFLICT (module_id) DO UPDATE
        SET applied_server_seq = CASE
          WHEN projection_watermarks.applied_server_seq > excluded.applied_server_seq
          THEN projection_watermarks.applied_server_seq
          ELSE excluded.applied_server_seq
        END
      `.execute(db);
    },
    async advanceLocalSeq(moduleId: string, value: number): Promise<void> {
      await sql`
        INSERT INTO projection_watermarks (module_id, applied_local_seq)
        VALUES (${moduleId}, ${value})
        ON CONFLICT (module_id) DO UPDATE
        SET applied_local_seq = CASE
          WHEN projection_watermarks.applied_local_seq > excluded.applied_local_seq
          THEN projection_watermarks.applied_local_seq
          ELSE excluded.applied_local_seq
        END
      `.execute(db);
    },
  };
}
