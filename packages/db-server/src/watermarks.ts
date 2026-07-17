// The SERVER embedding of the projection watermark store (04-module-contract §4.3; 10-db §8).
//
// task 08 (projection-engine) defined the `WatermarkStore` port and shipped the CLIENT
// implementation over `projection_watermarks (module_id PK, applied_server_seq + applied_local_seq)`
// (10-db §9.1), and recorded that "the server table (10-db §8, applied_server_seq only) … lands with
// tasks 07/16". This is that server implementation, over the server table whose PK is
// `(tenant_id, module_id)` and which has NO `applied_local_seq` column: server-side, projections
// apply synchronously inside the push transaction, so `applied_server_seq` is rebuild bookkeeping
// only and there is no own-device append seq to track (04 §4.3, 10-db §8). It satisfies the same
// port the engine's `applyPulledOp` calls, so the engine drives it unchanged; task 49 wires the
// projection-apply step into the push transaction and task 17 the conflict projection through it.
//
// ── WHY THIS LIVES IN db-server AND NOT IN apps/server (task 47) ───────────────────────────────
//
// It was born in `apps/server/src/sync/watermarks.ts`. Nothing about it is an app concern: it is
// raw SQL over a server table, and its only imports are `kysely` and `@bolusi/core` — both edges
// 08 §3.3 already grants db-server (`db-server → core, schemas, kysely, pg`). It has no dependency
// on the Hono app in either direction.
//
// What that address bought is the point. `packages/db-server` is the ONLY package whose suite
// re-runs against real PostgreSQL 16 (`pnpm test:rls`, `--project db-server`). While this code sat
// in apps/server, the PG16 lane could not import it (`packages/*` never import `apps/*`, 08 §3.3
// rule 1), so the atomicity test hand-copied it as a MIRROR and its header asked that "the two must
// be kept in sync". Task 47 measured what that discipline was worth: neutering production
// `advanceServerSeq` left the PG16 lane 95/95 GREEN, and deleting the `Number()` normalization from
// production `read()` was invisible to THREE gates at once — typecheck (the row type is asserted,
// task 39/46's shape), PGlite (returns int8 as a number, T-14f), and real PG16 (it ran the mirror).
//
// Moving the file is what closes that BY CONSTRUCTION (CLAUDE.md §2.11): the PG16 lane now imports
// this module, so it cannot drift from what it guards — there is nothing left to keep in sync.
import { sql, type Kysely } from 'kysely';

import { int8ToNumber, type Int8Value, type WatermarkStore } from '@bolusi/core';

/**
 * A server watermark store bound to one tenant. `tenantId` is the composite-PK partition and the
 * RLS predicate value — the store always runs inside a `forTenant` transaction (10-db §6), so the
 * write's `tenant_id` must equal `app.tenant_id` or RLS `WITH CHECK` rejects it.
 *
 * The engine computes the advancement (contiguity via `highestContiguousServerSeq` over the op
 * log); this store only reads/persists the scalar, keeping the monotonic MAX invariant at the
 * store (04 §4.3) even if a caller ever passes a lower value.
 */
export function createServerWatermarkStore<DB>(db: Kysely<DB>, tenantId: string): WatermarkStore {
  return {
    async read(moduleId: string) {
      // `Int8Value`, not `number`: asserting `number` here is precisely the lie task 46 was — the
      // real `pg` driver hands `applied_server_seq` back as a STRING, and a type assertion makes
      // tsc agree with the wrong thing. Naming the honest union is what forces the seam below to
      // exist, and what makes deleting it a type error rather than a silent string watermark.
      // `AS "appliedServerSeq"` resolves the result key by construction, not via `CamelCasePlugin`
      // (10-db §11.4; task 74). Without the plugin a bare column arrives as `applied_server_seq`,
      // `row.appliedServerSeq` is undefined, and `int8ToNumber(undefined)` throws — loud here (no
      // `?? 0` to launder it), but the coupling was still unasserted. The quoted alias is inert.
      const result = await sql<{ appliedServerSeq: Int8Value }>`
        SELECT applied_server_seq AS "appliedServerSeq" FROM projection_watermarks
        WHERE tenant_id = ${tenantId} AND module_id = ${moduleId}
      `.execute(db);
      const row = result.rows[0];
      // ONE int8 seam for the whole engine (@bolusi/core int8.ts, task 46) — not a local
      // `Number()`. A convention re-applied at each call site is how task 46 happened: one
      // function carried the cast and the neighbour twelve lines away did not (CLAUDE.md §2.8).
      // It also refuses past 2^53 instead of rounding a watermark into a wrong-but-silent value.
      // `applied_local_seq` has no server column — the port's server shape reports 0 (10-db §8).
      return {
        appliedServerSeq:
          row === undefined
            ? 0
            : int8ToNumber(row.appliedServerSeq, 'projection_watermarks.applied_server_seq'),
        appliedLocalSeq: 0,
      };
    },

    async advanceServerSeq(moduleId: string, value: number): Promise<void> {
      // The CASE (not `GREATEST`/`MAX(a,b)`) and the table-qualified column are the same
      // dialect-neutrality constraints core's watermarks.ts (task 11) documents: Postgres has no
      // two-arg `max()` and rejects an unqualified column on the right of `SET`.
      await sql`
        INSERT INTO projection_watermarks (tenant_id, module_id, applied_server_seq)
        VALUES (${tenantId}, ${moduleId}, ${value})
        ON CONFLICT (tenant_id, module_id) DO UPDATE
        SET applied_server_seq = CASE
          WHEN projection_watermarks.applied_server_seq > excluded.applied_server_seq
          THEN projection_watermarks.applied_server_seq
          ELSE excluded.applied_server_seq
        END
      `.execute(db);
    },

    // The server table has no `applied_local_seq` column (10-db §8): own-device appends are a
    // client concern. The engine only calls this on the append path, which the server never runs.
    async advanceLocalSeq(): Promise<void> {
      /* no-op: server projections have no local-append seq (10-db §8, 04 §4.3) */
    },
  };
}
