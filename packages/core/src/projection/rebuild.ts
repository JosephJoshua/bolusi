// Full projection rebuild with a resumable cursor (04-module-contract §4.3; FR-1116).
//
// Rebuild is the correctness escape hatch: clear the module's projection tables, replay ALL
// of its ops in canonical order (05 §4). Because canonical order means each op is the newest
// so far for its entity, every apply is head-case — no re-fold happens during a rebuild.
//
// Resumability: each batch commits its applies together with a `rebuild_cursor` checkpoint
// (the last canonical triple applied), stored as an engine-owned key in `meta_kv` (10-db §9.1
// — NO new table; a dedicated cursor table would be a stop-and-ask per CLAUDE.md §6). An
// interrupted rebuild reopens and resumes STRICTLY AFTER the cursor, so nothing at or below it
// is ever re-applied. `rebuild_cursor` is SEPARATE from the §4.3 watermarks: a rebuild replays
// the same ops and leaves applied_server_seq / applied_local_seq untouched (never decreasing
// them). On completion the cursor is cleared and the module's projectionVersion signature is
// recorded, so a version bump (04 §4.4) forces exactly one rebuild.
import { sql, type Kysely } from 'kysely';

import type { InvalidationBus } from './invalidation.js';
import { moduleVersionSignature, type ProjectionApplier } from './manifest.js';
import { cursorOf, readCanonicalPage, type CanonicalCursor } from './oplog-source.js';
import type { ProjectionRegistry } from './registry.js';
import type { ProjectionStats } from './stats.js';

/** Default rebuild page size (op-sqlite `executeBatch` bulk path, 10-db §9). */
export const DEFAULT_REBUILD_BATCH_SIZE = 500;

/**
 * Rebuild progress in `meta_kv`: `started` = tables cleared, nothing applied yet; `progress`
 * = last canonical triple checkpointed. Absent (null) = no rebuild in flight.
 */
export type RebuildCursorState =
  { readonly phase: 'started' } | { readonly phase: 'progress'; readonly cursor: CanonicalCursor };

/**
 * The durable rebuild bookkeeping port: the resume cursor and the applied version signature.
 * A client implementation over `meta_kv` is provided; the server (task 16) satisfies the same
 * port with its own scalar store. Every method takes a `Kysely<DB>` HANDLE so a batch can
 * checkpoint inside its own transaction (pass the `Transaction`), never on a separate one.
 */
export interface RebuildStore {
  readCursor(moduleId: string): Promise<RebuildCursorState | null>;
  writeCursor(moduleId: string, state: RebuildCursorState): Promise<void>;
  clearCursor(moduleId: string): Promise<void>;
  readVersion(moduleId: string): Promise<string | null>;
  writeVersion(moduleId: string, signature: string): Promise<void>;
}

const CURSOR_KEY = (moduleId: string): string => `projection.${moduleId}.rebuild_cursor`;
const VERSION_KEY = (moduleId: string): string => `projection.${moduleId}.version`;

async function readMeta<DB>(db: Kysely<DB>, key: string): Promise<string | null> {
  const result = await sql<{ value: string }>`
    SELECT value FROM meta_kv WHERE key = ${key}
  `.execute(db);
  return result.rows[0]?.value ?? null;
}

async function writeMeta<DB>(db: Kysely<DB>, key: string, value: string): Promise<void> {
  await sql`
    INSERT INTO meta_kv (key, value) VALUES (${key}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `.execute(db);
}

/** Client rebuild store over `meta_kv` (10-db §9.1). Values are JSON scalars. */
export function createSqlRebuildStore<DB>(db: Kysely<DB>): RebuildStore {
  return {
    async readCursor(moduleId: string): Promise<RebuildCursorState | null> {
      const raw = await readMeta(db, CURSOR_KEY(moduleId));
      return raw === null ? null : (JSON.parse(raw) as RebuildCursorState);
    },
    writeCursor(moduleId: string, state: RebuildCursorState): Promise<void> {
      return writeMeta(db, CURSOR_KEY(moduleId), JSON.stringify(state));
    },
    async clearCursor(moduleId: string): Promise<void> {
      await sql`DELETE FROM meta_kv WHERE key = ${CURSOR_KEY(moduleId)}`.execute(db);
    },
    readVersion(moduleId: string): Promise<string | null> {
      return readMeta(db, VERSION_KEY(moduleId));
    },
    writeVersion(moduleId: string, signature: string): Promise<void> {
      return writeMeta(db, VERSION_KEY(moduleId), signature);
    },
  };
}

/** The result of a `runRebuild` call. `complete: false` ⇒ it was interrupted and can resume. */
export interface RebuildOutcome {
  /** True when the whole log was replayed and the cursor cleared. */
  readonly complete: boolean;
  /** Batches applied by THIS call. */
  readonly batches: number;
  /** Ops applied by THIS call. */
  readonly appliedCount: number;
  /** True when this call started a fresh rebuild (cleared tables); false when it resumed. */
  readonly startedFresh: boolean;
}

export interface RunRebuildContext<DB> {
  readonly db: Kysely<DB>;
  readonly registry: ProjectionRegistry<DB>;
  readonly makeStore: (handle: Kysely<DB>) => RebuildStore;
  readonly invalidation: InvalidationBus;
  readonly stats: ProjectionStats;
}

export interface RunRebuildOptions {
  readonly batchSize?: number;
  /**
   * Stop after this many batches, leaving a valid checkpoint — the test hook that models a
   * crash mid-rebuild (CHAOS-08a). A later `runRebuild` resumes from the cursor.
   */
  readonly stopAfterBatches?: number;
}

/**
 * Run (or resume) a full rebuild of `moduleId`. Fresh start clears the module's tables and
 * marks `started`; resume continues strictly after the checkpoint. Each batch — applies plus
 * the cursor checkpoint — commits atomically, so an interruption between batches leaves a
 * consistent resume point and never a partially-applied batch.
 */
export async function runRebuild<DB>(
  ctx: RunRebuildContext<DB>,
  moduleId: string,
  options: RunRebuildOptions = {},
): Promise<RebuildOutcome> {
  const module = ctx.registry.module(moduleId);
  if (module === undefined) {
    throw new Error(`cannot rebuild unregistered module: ${moduleId}`);
  }
  const batchSize = options.batchSize ?? DEFAULT_REBUILD_BATCH_SIZE;
  const stopAfterBatches = options.stopAfterBatches ?? Number.POSITIVE_INFINITY;
  const opTypes = ctx.registry.moduleOpTypes(module);
  const tables = new Set(ctx.registry.moduleTableNames(module));

  const rootStore = ctx.makeStore(ctx.db);
  const existing = await rootStore.readCursor(moduleId);

  let after: CanonicalCursor | null;
  let startedFresh = false;
  if (existing === null) {
    startedFresh = true;
    ctx.stats.recordRebuildStart();
    await ctx.db.transaction().execute(async (trx) => {
      for (const table of tables) {
        await sql`DELETE FROM ${sql.table(table)}`.execute(trx);
      }
      await ctx.makeStore(trx).writeCursor(moduleId, { phase: 'started' });
    });
    after = null;
  } else if (existing.phase === 'started') {
    after = null;
  } else {
    after = existing.cursor;
  }

  let batches = 0;
  let appliedCount = 0;
  let complete = false;

  while (batches < stopAfterBatches) {
    const page = await readCanonicalPage(ctx.db, opTypes, after, batchSize);
    if (page.length === 0) {
      complete = true;
      break;
    }
    const lastCursor = cursorOf(page[page.length - 1] as (typeof page)[number]);
    await ctx.db.transaction().execute(async (trx) => {
      for (const op of page) {
        const applier = module.appliers[op.type] as ProjectionApplier<DB>;
        await applier(trx, op);
      }
      await ctx.makeStore(trx).writeCursor(moduleId, { phase: 'progress', cursor: lastCursor });
    });
    after = lastCursor;
    batches += 1;
    appliedCount += page.length;
    ctx.stats.recordRebuildBatch(page.length);
    ctx.invalidation.emit(tables);
    if (page.length < batchSize) {
      complete = true;
      break;
    }
  }

  if (complete) {
    await ctx.db.transaction().execute(async (trx) => {
      const store = ctx.makeStore(trx);
      await store.clearCursor(moduleId);
      await store.writeVersion(moduleId, moduleVersionSignature(module));
    });
  }

  return { complete, batches, appliedCount, startedFresh };
}
