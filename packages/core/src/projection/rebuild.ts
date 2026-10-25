// Full projection rebuild with a resumable cursor (04-module-contract §4.3; FR-1116).
//
// Rebuild is the correctness escape hatch, and on a device it runs after an app update bumps a
// module's projectionVersion (04 §4.4) — in the background, while the shop keeps working. So it does
// NOT clear the module's tables and replay the log: that empties every screen for minutes and makes
// every concurrent write a hazard. It re-folds ENTITY BY ENTITY, exactly the engine's §4.2 re-fold:
// delete one entity's rows, replay that entity's whole history in canonical order. Appliers may write
// only rows keyed by their op's entity (§4.1 rule 2), so this reproduces the canonical fold, and at
// every moment each entity's rows are complete (old version or new, never half of either).
//
// Concurrent applies need no coordination. A pulled or appended op for an entity the rebuild has
// passed is folded by the engine as usual; for one it has not reached, it is folded now and again,
// from the log, when the rebuild gets there. Either way the entity ends at its canonical fold.
//
// Resumability: each batch of entities commits together with a `rebuild_cursor` checkpoint (the last
// entity re-folded), stored as an engine-owned key in `meta_kv` (10-db §9.1). An interrupted rebuild
// resumes after the cursor. The cursor carries the version signature it is rebuilding to: after an
// app update mid-rebuild, the entities before the cursor were folded by the old appliers, so a cursor
// for another version restarts from the first entity. Re-folding an entity twice is harmless; only
// skipping one would not be. `rebuild_cursor` is SEPARATE from the §4.3 watermarks, which a rebuild
// leaves untouched. On completion the cursor is cleared and the version signature recorded, so a
// version bump forces exactly one rebuild.
import { sql, type Kysely } from 'kysely';

import type { InvalidationBus } from './invalidation.js';
import { moduleVersionSignature, type ModuleProjectionManifest } from './manifest.js';
import { readEntitiesOps, readEntityPage, type EntityCursor } from './oplog-source.js';
import type { ProjectionRegistry } from './registry.js';
import type { ProjectionStats } from './stats.js';

/**
 * Default rebuild page size, in ENTITIES. One page is one transaction, and the app's one connection
 * serves nothing else while it runs, so a page must stay short on a phone: 25 repair tickets are
 * about 175 ops.
 */
export const DEFAULT_REBUILD_BATCH_SIZE = 25;

/**
 * Rebuild progress in `meta_kv`: the version signature being rebuilt to, and the last entity
 * re-folded (`null` before the first page commits). Absent (null) = no rebuild in flight.
 */
export interface RebuildCursorState {
  readonly version: string;
  readonly after: EntityCursor | null;
}

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

/**
 * A stored cursor, or null when there is none or it is not this shape (a cursor an older build
 * wrote). Null restarts the rebuild from the first entity, which is always safe.
 */
function parseCursor(raw: string | null): RebuildCursorState | null {
  if (raw === null) return null;
  const value = JSON.parse(raw) as Partial<RebuildCursorState> | null;
  if (typeof value?.version !== 'string' || value.after === undefined) return null;
  const after = value.after;
  if (
    after !== null &&
    (typeof after.entityType !== 'string' || typeof after.entityId !== 'string')
  ) {
    return null;
  }
  return { version: value.version, after };
}

/** Client rebuild store over `meta_kv` (10-db §9.1). Values are JSON scalars. */
export function createSqlRebuildStore<DB>(db: Kysely<DB>): RebuildStore {
  return {
    async readCursor(moduleId: string): Promise<RebuildCursorState | null> {
      return parseCursor(await readMeta(db, CURSOR_KEY(moduleId)));
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

/**
 * Re-fold some entities of one type (§4.2): delete their rows from the module's tables for that
 * type, then replay each entity's whole history in canonical order. Returns the ops applied. The
 * engine's out-of-order path re-folds one entity through this; the rebuild re-folds a page at a time.
 */
export async function refoldEntities<DB>(
  db: Kysely<DB>,
  registry: ProjectionRegistry<DB>,
  module: ModuleProjectionManifest<DB>,
  entityType: string,
  entityIds: readonly string[],
): Promise<number> {
  const ids = sql.join(entityIds.map((id) => sql`${id}`));
  for (const ref of registry.tablesForEntityType(module, entityType)) {
    await sql`
      DELETE FROM ${sql.table(ref.table)} WHERE ${sql.ref(ref.entityIdColumn)} IN (${ids})
    `.execute(db);
  }
  const histories = await readEntitiesOps(db, entityType, entityIds);
  let applied = 0;
  for (const entityId of entityIds) {
    for (const op of histories.get(entityId) ?? []) {
      // An op on this entity of a type the module does not fold (another module's) is skipped.
      const applier = module.appliers[op.type];
      if (applier === undefined) continue;
      await applier(db, op);
      applied += 1;
    }
  }
  return applied;
}

/** The result of a `runRebuild` call. `complete: false` ⇒ it was interrupted and can resume. */
export interface RebuildOutcome {
  /** True when every entity was re-folded and the cursor cleared. */
  readonly complete: boolean;
  /** Batches applied by THIS call. */
  readonly batches: number;
  /** Ops applied by THIS call. */
  readonly appliedCount: number;
  /** True when this call started from the first entity; false when it resumed a cursor. */
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
  /** Entities per batch (one transaction each). */
  readonly batchSize?: number;
  /**
   * Stop after this many batches, leaving a valid checkpoint. Models a crash mid-rebuild in tests
   * (CHAOS-08a), and lets a caller run a rebuild a batch at a time. A later call resumes.
   */
  readonly stopAfterBatches?: number;
}

const sameCursor = (a: RebuildCursorState | null, b: RebuildCursorState): boolean =>
  a !== null &&
  a.version === b.version &&
  a.after?.entityType === b.after?.entityType &&
  a.after?.entityId === b.after?.entityId;

/**
 * Run (or resume) a full rebuild of `moduleId`. Each batch (re-folds plus the cursor checkpoint)
 * commits atomically, so an interruption between batches leaves a consistent resume point. A batch
 * that finds the cursor moved under it (another rebuild of the same module) stops this call.
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
  const version = moduleVersionSignature(module);

  const existing = await ctx.makeStore(ctx.db).readCursor(moduleId);
  const resumable = existing?.version === version ? existing : null;
  const startedFresh = resumable === null;
  let cursor: RebuildCursorState = resumable ?? { version, after: null };
  if (startedFresh) {
    ctx.stats.recordRebuildStart();
    await ctx.makeStore(ctx.db).writeCursor(moduleId, cursor);
  }

  let batches = 0;
  let appliedCount = 0;
  let complete = false;

  while (batches < stopAfterBatches) {
    const expected = cursor;
    const batch = await ctx.db.transaction().execute(async (trx) => {
      const store = ctx.makeStore(trx);
      if (!sameCursor(await store.readCursor(moduleId), expected)) return null;
      const entities = await readEntityPage(trx, opTypes, expected.after, batchSize);
      let applied = 0;
      // The page is in (entityType, entityId) order, so each type's entities are one run.
      for (let start = 0; start < entities.length;) {
        const entityType = entities[start]!.entityType;
        let end = start;
        while (end < entities.length && entities[end]!.entityType === entityType) end += 1;
        const ids = entities.slice(start, end).map((entity) => entity.entityId);
        applied += await refoldEntities(trx, ctx.registry, module, entityType, ids);
        start = end;
      }
      const next: RebuildCursorState = {
        version,
        after: entities.length === 0 ? expected.after : entities[entities.length - 1]!,
      };
      const done = entities.length < batchSize;
      if (done) {
        await store.clearCursor(moduleId);
        await store.writeVersion(moduleId, version);
      } else {
        await store.writeCursor(moduleId, next);
      }
      return { entities: entities.length, applied, next, done };
    });
    if (batch === null) break;
    cursor = batch.next;
    if (batch.entities > 0) {
      batches += 1;
      appliedCount += batch.applied;
      ctx.stats.recordRebuildBatch(batch.applied);
      ctx.invalidation.emit(tables);
    }
    if (batch.done) {
      complete = true;
      break;
    }
  }

  return { complete, batches, appliedCount, startedFresh };
}
