// Projection watermarks (04-module-contract §4.3).
//
//   applied_server_seq = highest CONTIGUOUS op-log sequence applied from pull.
//   applied_local_seq  = highest local seq applied at append (own-device ops).
//
// THE COLUMN THE FIRST LINE COUNTS IS NOT THE SAME ON BOTH SIDES (10-db §9.2's table; D20 §4).
// Server-side it is `operations.server_seq`, the per-tenant acceptance counter. CLIENT-side it is
// `operations.arrival_seq`, a LOCAL arrival counter — the client cannot hold real serverSeqs, whose
// gaps would pin this watermark below the first other-store op forever. The scalar's own name is
// left alone deliberately: it is one shared port satisfied by both sides, and the engine's
// `seqColumn` (engine.ts) is where the difference is named, once.
//
// Both are STRICTLY MONOTONIC and never decrease — not by pull, not by append, not by the
// entity-local re-fold (§4.2, which re-applies already-counted ops and so moves NEITHER), and
// not by a rebuild resume. Watermarks answer "is this projection caught up?", nothing else.
//
// This module owns the STORE PORT plus a client implementation over the `projection_watermarks`
// table (10-db §9.1, both columns). The port is the shape BOTH sides satisfy: the client here,
// and the server table (10-db §8, applied_server_seq only) when tasks 07/16 embed it — only the
// client shape is exercised now. The engine computes the advancement (contiguity via the op
// log — oplog-source `highestContiguousSeq`); the store only reads/persists the scalars.
//
// JUDGMENT CALL (04 §4.3 is terse): contiguity is evaluated over the WHOLE sequence stream in the
// device's single-tenant op log, NOT the module-filtered subset — the engine reads the sequence
// column for presence, so a value belonging to another module still counts toward the contiguous
// prefix and never creates a phantom gap. A module's watermark is re-evaluated only when one of
// ITS ops is applied, so a module can lag the frontier until its next op; the sync loop (task 15)
// may additionally raise it. Recorded so nobody "fixes" the lag ad hoc.
//
// AND THE STREAM IS GAPLESS FOR DIFFERENT REASONS ON THE TWO SIDES — do not collapse them. Server-
// side it is 10-db §3: the `tenant_op_counters` row lock makes `server_seq` gapless per tenant.
// CLIENT-side 10-db §3 says NOTHING about what this device holds — its stream is scope-FILTERED
// (api/01 §4.3), so the server's real serverSeqs would be legitimately gappy here. This file used
// to cite "10-db §3: gapless per tenant" for both. The client stream is gapless ONLY because
// `nextArrivalSeq` (sync/pull.ts) numbers arrivals itself, which makes that counter load-bearing
// for this whole file — asserted in core/test/sync/arrival-seq.test.ts, not assumed here (§2.11).
import { sql, type Kysely } from 'kysely';

import { int8ToNumber } from './int8.js';

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
      // Columns ALIASED to their camelCase result key, not relying on `CamelCasePlugin` to rewrite
      // raw-`sql` result keys (10-db §11.4; task 74). Without the plugin a bare `SELECT
      // applied_server_seq` arrives as `applied_server_seq`, `row.appliedServerSeq` is undefined,
      // and the `?? 0` this used to carry laundered it into a SILENT watermark of 0 (T-19) — a
      // stalled projection with no error. Both columns are `NOT NULL DEFAULT 0` (10-db §9.1), so
      // `?? 0` could NEVER fire for a legitimate null; it only ever masked a missing key. It is
      // gone: a resolved value is normalised, an unresolved key makes `int8ToNumber(undefined)`
      // throw loudly — exactly what the server reader (db-server/watermarks.ts) does.
      //
      // The asserted type is the union the DRIVERS actually produce, not `number`: the real `pg`
      // driver returns int8 as a STRING — int8's range exceeds JS's safe integers, so node-postgres
      // will not silently narrow it — while SQLite AND PGlite return a number (PGlite, this suite's
      // ONLY Postgres, hands back a `number` in range and a `bigint` past 2^53 — never a string). So
      // the STRING branch is DEFENDED here but not DEMONSTRATED by this suite: the cast below is a
      // no-op on PGlite, and the string is exercised on real `pg` by
      // db-server/test/projection-int8-marshalling.test.ts (full driver matrix: int8.ts). A
      // raw-`sql<>` annotation is believed by the compiler and checked by nobody, so claiming
      // `number` here would just hide the string a shipping build against real `pg` will meet.
      const result = await sql<{
        appliedServerSeq: string | number | bigint;
        appliedLocalSeq: string | number | bigint;
      }>`
        SELECT applied_server_seq AS "appliedServerSeq", applied_local_seq AS "appliedLocalSeq"
        FROM projection_watermarks WHERE module_id = ${moduleId}
      `.execute(db);
      const row = result.rows[0];
      return {
        appliedServerSeq:
          row === undefined
            ? 0
            : int8ToNumber(row.appliedServerSeq, 'projection_watermarks.applied_server_seq'),
        appliedLocalSeq:
          row === undefined
            ? 0
            : int8ToNumber(row.appliedLocalSeq, 'projection_watermarks.applied_local_seq'),
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
