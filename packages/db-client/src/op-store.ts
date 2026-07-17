// The PRODUCTION client op-append store (04-module-contract §5.1 steps 4–6; 05-operation-log §1, §5).
//
// @bolusi/core owns the append/chain/sign LOGIC (`appendLocalOps`, `assertGenesisRules`,
// `completeDraft`) but is platform-free (08 §3.3): it may not touch a driver. It declares the
// `OpAppendStore` port and leaves the transaction + row I/O to be BOUND downstream. This is that
// binding — the one production producer of `OpAppendStore`, over the one client connection
// (`ClientDb`, 08 §2.2).
//
// ── WHY THIS FILE EXISTS AT ALL (T-16: a mention is not a producer) ──────────────────────────────
// Until this task the ONLY `OpAppendStore` in the repo was the auth suite's test fixture
// (`packages/core/test/auth/_harness.ts`'s `SqliteOpStore`). Nothing in shipping source composed a
// `CommandRuntime`, so `runEnrollment`'s genesis append had no store to run through and a production
// device could never write seq 1 — so `deviceId` never persisted, so the sync loop never started.
// This is the missing producer. Per CLAUDE.md §2.8 the fixture is not COPIED here — it is PROMOTED:
// `_harness.ts` now delegates to `createClientOpStore`, so the whole auth suite (genesis, chaining,
// tamper, atomicity) exercises THIS code, not a parallel copy.
//
// ── THE TRANSACTION IS THE ATOM (04 §5.1 steps 5–6) ─────────────────────────────────────────────
// `appendLocalOps` runs readChainHead → insertOp → applyProjection inside ONE `transaction(fn)`.
// The projection seam (task 08's engine) writes through the SAME connection, so an applier throw
// propagates out of `fn`, hits the catch below, and rolls the whole command back: no op row, chain
// head unmoved. begin/commit/rollback go on the raw driver (not `ClientDb.transaction`) because the
// tx SURFACE handed to `fn` reads/writes via the Kysely handle, and both must sit inside the same
// begin — exactly the shape the promoted fixture had.
import { sql, type Kysely } from 'kysely';

import type { ChainHead, OpAppendStore, OpAppendTx, OpRow } from '@bolusi/core';

import type { DbDriver } from './driver.js';
import type { ClientDatabase } from './generated/index.js';

/**
 * The slice of the client connection the op store needs: the typed Kysely handle for the row I/O
 * and the raw driver's transaction primitives. `ClientDb` (connection.ts) satisfies this
 * structurally, and so does the auth suite's raw `{ db, driver }` pair — one implementation, two
 * callers.
 */
export interface OpStoreConnection {
  readonly db: Kysely<ClientDatabase>;
  readonly driver: Pick<DbDriver, 'begin' | 'commit' | 'rollback'>;
}

/**
 * Build the production `OpAppendStore` over the one client connection.
 *
 * `transaction(fn)` opens ONE driver transaction and runs `fn` against a tx surface bound to the
 * same connection. ANY throw — a genesis-rule violation, a JCS error, or an applier throw inside
 * the projection seam — rolls the whole thing back (04 §5.1 atomicity). The rollback itself is
 * guarded so a rollback failure cannot mask the original error (which is what actually tells the
 * caller what went wrong).
 */
export function createClientOpStore(conn: OpStoreConnection): OpAppendStore {
  return {
    async transaction<T>(fn: (tx: OpAppendTx) => Promise<T>): Promise<T> {
      await conn.driver.begin();
      try {
        const result = await fn(makeTx(conn.db));
        await conn.driver.commit();
        return result;
      } catch (error) {
        try {
          await conn.driver.rollback();
        } catch {
          // Preserve the ORIGINAL error: a rollback that also fails must not become the error the
          // caller sees, or a genesis-rule violation would surface as "rollback failed".
        }
        throw error;
      }
    },
  };
}

/** The transactional surface `appendLocalOps` drives — reads via raw `sql`, writes via Kysely. */
function makeTx(db: Kysely<ClientDatabase>): OpAppendTx {
  return {
    async readChainHead(deviceId: string): Promise<ChainHead | null> {
      // The device chain head: the highest-seq op this device holds (05 §4). `null` ⇒ genesis.
      const rows = await sql<{ seq: number; hash: string }>`
        SELECT seq, hash FROM operations WHERE device_id = ${deviceId}
        ORDER BY seq DESC LIMIT 1
      `.execute(db);
      const head = rows.rows[0];
      return head === undefined ? null : { seq: head.seq, hash: head.hash };
    },

    async hasOp(id: string): Promise<boolean> {
      // The dedup key (05 §5): a pre-existing id is inert — not inserted, not projected.
      const rows = await sql<{ one: number }>`
        SELECT 1 AS one FROM operations WHERE id = ${id} LIMIT 1
      `.execute(db);
      return rows.rows.length > 0;
    },

    async insertOp({ op, signedCoreJcs }: OpRow): Promise<void> {
      // Born `syncStatus = 'local'` (03 §3 birth state); `serverSeq`/`syncedAt` null until pushed.
      // `signedCoreJcs` is persisted VERBATIM (10-db §2.1) — re-serializing from typed columns can
      // change bytes and break a genuine signature (05 §3).
      await db
        .insertInto('operations')
        .values({
          id: op.id,
          tenantId: op.tenantId,
          storeId: op.storeId,
          userId: op.userId,
          deviceId: op.deviceId,
          seq: op.seq,
          type: op.type,
          entityType: op.entityType,
          entityId: op.entityId,
          schemaVersion: op.schemaVersion,
          payload: JSON.stringify(op.payload),
          timestampMs: op.timestamp,
          location: op.location === null ? null : JSON.stringify(op.location),
          source: op.source,
          agentInitiated: op.agentInitiated ? 1 : 0,
          agentConversationId: op.agentConversationId,
          previousHash: op.previousHash,
          hash: op.hash,
          signature: op.signature,
          signedCoreJcs,
          syncStatus: 'local',
          serverSeq: null,
          syncedAt: null,
        })
        .execute();
    },
  };
}
