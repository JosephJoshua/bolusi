// The SERVER projection engine (04-module-contract §4; 10-db §3 step 6). ONE construction of the
// order-independent projection runtime bound to the server watermark store, so the push pipeline
// (apps/server) and the real-PG16 atomicity lane construct it IDENTICALLY rather than each keeping
// a copy (CLAUDE.md §2.8) — the mirror task 47 deleted for the watermark store, not reintroduced
// one layer up as three hand-rolled `new ProjectionEngine({...})` call sites.
//
// WHY IT LIVES IN db-server. It composes @bolusi/core's `ProjectionEngine` with THIS package's
// `createServerWatermarkStore` (10-db §8). core cannot import db-server (that edge inverts the
// dependency), and apps/server's copy could not be executed by `pnpm test:rls` — the PG16 lane is
// `--project db-server`, and packages/* never import apps/* (08 §3.3 rule 1). Homed here, the exact
// construction the pipeline runs is the one PG16 exercises: closed BY CONSTRUCTION, not discipline.
import { ProjectionEngine } from '@bolusi/core';
import type { ProjectionRegistry, RebuildStore } from '@bolusi/core';
import type { Kysely } from 'kysely';

import { createServerWatermarkStore } from './watermarks.js';

// The push transaction NEVER rebuilds: server-side `applied_server_seq` is rebuild BOOKKEEPING only
// (10-db §8, 04 §4.3), and a rebuild is the standalone `rebuild.ts` path, not a per-op push
// concern. A store that throws turns "the push path somehow reached rebuild" into a loud failure
// inside the transaction (which rolls back) rather than a silent wrong answer — the server has no
// `meta_kv` cursor table for a rebuild store to read anyway (10-db §8 vs §9.1).
const PUSH_NEVER_REBUILDS: RebuildStore = {
  readCursor: () => Promise.reject(new Error('the push transaction does not rebuild (10-db §8)')),
  writeCursor: () => Promise.reject(new Error('the push transaction does not rebuild (10-db §8)')),
  clearCursor: () => Promise.reject(new Error('the push transaction does not rebuild (10-db §8)')),
  readVersion: () => Promise.reject(new Error('the push transaction does not rebuild (10-db §8)')),
  writeVersion: () => Promise.reject(new Error('the push transaction does not rebuild (10-db §8)')),
};

/**
 * Construct the projection engine for one tenant-bound push transaction. `db` is the handle the
 * caller already holds from `forTenant` (RLS-scoped); `registry` is the assembled module registry
 * (04 §4) — the SAME appliers the client runs (04 §2, T-8). The returned engine's `applyPulledOp`
 * folds an accepted op into the server read models and advances the tenant/module watermark to the
 * highest CONTIGUOUS serverSeq in the log, all through `db`, so it commits or rolls back with the
 * op insert (10-db §3 — atomic by sharing the transaction).
 */
export function createServerProjectionEngine<DB>(
  db: Kysely<DB>,
  tenantId: string,
  registry: ProjectionRegistry<DB>,
): ProjectionEngine<DB> {
  return new ProjectionEngine<DB>({
    db,
    registry,
    watermarks: createServerWatermarkStore(db, tenantId),
    // The SERVER log numbers accepted ops with the per-tenant acceptance counter (10-db §3/§5).
    // The client's `arrival_seq` (10-db §9.2, D20 §4) is a different number and does not exist in
    // this schema, so a mis-wiring here errors rather than answering wrongly.
    seqColumn: 'server_seq',
    makeRebuildStore: () => PUSH_NEVER_REBUILDS,
  });
}
