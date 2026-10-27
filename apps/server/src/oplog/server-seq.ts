// Per-tenant gapless serverSeq allocation via the `tenant_op_counters` row lock (10-db §3).
//
// The row is locked FOR UPDATE at transaction start (serialising pushes per tenant, allocating
// nothing), then advanced by one per ACCEPTED op. Duplicates and rejected ops never reach the
// increment, so per-tenant serverSeq is gapless BY CONSTRUCTION — there is no up-front block
// allocation. Cross-tenant pushes touch different rows and never contend (§3).
//
// Why not bigserial/a global sequence: sequence values become visible out of commit order, so a
// puller could advance its cursor past an op still uncommitted and miss it forever. The row lock
// makes serverSeq commit-ordered within a tenant, which is what makes `WHERE server_seq > cursor`
// safe (§3). The genuine-concurrency proof lives in db-server's real-Postgres lane
// (packages/db-server/test/oplog-server-seq-concurrency.test.ts), which races two REAL pooled
// connections; a sequential test proves only that the lock is EMITTED, never that it holds under
// contention.
import { sql } from 'kysely';

import type { TenantDb } from '@bolusi/db-server';

/**
 * Take the per-tenant counter lock at transaction start (§3) and return the next serverSeq to
 * assign. Allocates nothing.
 *
 * Provisioning (task 13) creates the counter row with the tenant; a lazy idempotent insert covers a
 * tenant that somehow lacks one, so it cannot wedge the pipeline. The insert runs only when the row
 * is missing: an `INSERT … ON CONFLICT` on every push is a write that waits on the same row lock.
 */
export async function lockTenantCounter(db: TenantDb, tenantId: string): Promise<number> {
  const lock = () =>
    db
      .selectFrom('tenantOpCounters')
      .select('nextServerSeq')
      .where('tenantId', '=', tenantId)
      .forUpdate()
      .executeTakeFirst();

  let row = await lock();
  if (row === undefined) {
    await db
      .insertInto('tenantOpCounters')
      .values({ tenantId })
      .onConflict((oc) => oc.doNothing())
      .execute();
    row = await lock();
  }
  if (row === undefined) throw new Error(`no op counter for tenant ${tenantId}`);
  return Number(row.nextServerSeq);
}

/**
 * Store the next serverSeq after a push assigned a run of them in memory under the lock. The push
 * numbers its accepted ops itself (next, next+1, …) and writes the counter once, rather than one
 * `UPDATE … RETURNING` per op; the row lock it holds makes that the same gapless, commit-ordered
 * stream. Write it before anything else allocates in this transaction (system ops below).
 */
export async function storeTenantCounter(
  db: TenantDb,
  tenantId: string,
  nextServerSeq: number,
): Promise<void> {
  await db
    .updateTable('tenantOpCounters')
    .set({ nextServerSeq: String(nextServerSeq) })
    .where('tenantId', '=', tenantId)
    .execute();
}

/**
 * Allocate ONE serverSeq for an accepted op (§3):
 *   `UPDATE tenant_op_counters SET next_server_seq = next_server_seq + 1 ... RETURNING it - 1`.
 * `next_server_seq` is "the next value to assign"; the returned `next_server_seq - 1` is the value
 * this op consumes. Called only on the accepted branch, so the stream stays gapless.
 */
export async function allocateServerSeq(db: TenantDb, tenantId: string): Promise<number> {
  // The arithmetic is raw `sql` rather than the expression builder because `next_server_seq` is a
  // bigint (Int8): Kysely types an `eb(col, '+', n)` operand from the column's SELECT type, which
  // for Int8 is `string`, so a numeric literal does not typecheck. Raw fragments also keep this
  // statement byte-identical to 10-db §3's normative SQL. Raw SQL speaks the snake_case column
  // names verbatim — CamelCasePlugin only rewrites builder identifiers.
  const row = await db
    .updateTable('tenantOpCounters')
    .set({ nextServerSeq: sql<string>`next_server_seq + 1` })
    .where('tenantId', '=', tenantId)
    .returning(sql<string>`next_server_seq - 1`.as('serverSeq'))
    .executeTakeFirstOrThrow();
  return Number(row.serverSeq);
}
