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
 * Client watermark store over `projection_watermarks` (10-db §9.1). Dialect-neutral raw SQL:
 * an upsert whose `ON CONFLICT ... DO UPDATE` takes `MAX(existing, proposed)` so a lower value
 * can never regress the watermark, even if a caller passes one (defense in depth for §4.3).
 */
export function createSqlWatermarkStore<DB>(db: Kysely<DB>): WatermarkStore {
  return {
    async read(moduleId: string): Promise<WatermarkState> {
      const result = await sql<{ appliedServerSeq: number; appliedLocalSeq: number }>`
        SELECT applied_server_seq, applied_local_seq
        FROM projection_watermarks WHERE module_id = ${moduleId}
      `.execute(db);
      const row = result.rows[0];
      return {
        appliedServerSeq: row?.appliedServerSeq ?? 0,
        appliedLocalSeq: row?.appliedLocalSeq ?? 0,
      };
    },
    async advanceServerSeq(moduleId: string, value: number): Promise<void> {
      await sql`
        INSERT INTO projection_watermarks (module_id, applied_server_seq)
        VALUES (${moduleId}, ${value})
        ON CONFLICT (module_id) DO UPDATE
        SET applied_server_seq = MAX(applied_server_seq, excluded.applied_server_seq)
      `.execute(db);
    },
    async advanceLocalSeq(moduleId: string, value: number): Promise<void> {
      await sql`
        INSERT INTO projection_watermarks (module_id, applied_local_seq)
        VALUES (${moduleId}, ${value})
        ON CONFLICT (module_id) DO UPDATE
        SET applied_local_seq = MAX(applied_local_seq, excluded.applied_local_seq)
      `.execute(db);
    },
  };
}
