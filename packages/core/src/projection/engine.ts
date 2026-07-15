// The projection engine (04-module-contract §4). It owns the load-bearing property of the
// whole projection layer — ORDER-INDEPENDENT CONVERGENCE (FR-1118): ops arrive out of order
// routinely, and the projection must converge to the SAME result regardless of arrival order.
// The RUNTIME guarantees this, never the applier (§4.2):
//
//   HEAD case  — the op is canonically newest for its entity ⇒ apply it incrementally.
//   OUT-OF-ORDER case — the op sorts before an already-applied op for its entity (canonical
//     order timestamp,deviceId,seq — 05 §4) ⇒ delete the entity's projection rows and RE-FOLD
//     its FULL op history in canonical order.
//
// So appliers only ever see canonical-order input. `stats` exposes the head/re-fold counts a
// convergence run must confirm it exercised (CHAOS-01, else inconclusive).
//
// TRANSACTION MODEL: `applyAppendedOp` / `applyPulledOp` do NOT open their own transaction —
// they run inside the caller's (the append path's store transaction — 04 §5.1 steps 5–6 — or
// the pull transaction — api/01 §4), which is what makes append-and-project atomic. All writes
// go through the injected `db`, which shares the one connection (10-db §9), so an applier throw
// propagates and the caller's transaction rolls the whole op back: entity rows are not left
// deleted, watermarks unmoved. A rebuild, being standalone, manages its own per-batch
// transactions (rebuild.ts).
//
// DELIVERY CONTRACT: each op is inserted into the op log immediately before its apply call, and
// ops are applied ONE AT A TIME (exactly the append seam's shape). Idempotent replay is the
// insert layer's job (05 §5: a duplicate `id` is not inserted, so apply is never called for it)
// — the engine's re-fold is inherently idempotent, and this contract keeps head-apply so too.
import { sql, type Kysely } from 'kysely';

import type { ProjectionApply } from '../oplog/append.js';
import type { ModuleProjectionManifest, ProjectionOperation } from './manifest.js';
import { moduleVersionSignature } from './manifest.js';
import { hasNewerEntityOp, highestContiguousServerSeq, readEntityOps } from './oplog-source.js';
import type { ProjectionRegistry } from './registry.js';
import {
  createSqlRebuildStore,
  runRebuild,
  type RebuildOutcome,
  type RebuildStore,
  type RunRebuildOptions,
} from './rebuild.js';
import { InvalidationBus } from './invalidation.js';
import { ProjectionStats } from './stats.js';
import { createSqlWatermarkStore, type WatermarkState, type WatermarkStore } from './watermarks.js';

/** How an op was incorporated (§4.2), for tests + observability. */
export type ApplyMode = 'head' | 'refold' | 'unregistered';

export interface ApplyOutcome {
  /** The owning module id, or null when no module handles the op type. */
  readonly module: string | null;
  readonly mode: ApplyMode;
  /** Tables written (per-table invalidation was fired for these). */
  readonly writtenTables: readonly string[];
}

export interface ProjectionEngineOptions<DB> {
  readonly db: Kysely<DB>;
  readonly registry: ProjectionRegistry<DB>;
  readonly watermarks: WatermarkStore;
  /** Factory so rebuild can bind the store to a batch transaction (rebuild.ts). */
  readonly makeRebuildStore: (handle: Kysely<DB>) => RebuildStore;
  readonly invalidation?: InvalidationBus;
  readonly stats?: ProjectionStats;
}

/**
 * The order-independent projection runtime. One instance per device DB, holding no durable
 * state of its own: everything survivable (projection rows, watermarks, rebuild cursor) is in
 * the DB, so a fresh engine on the same DB resumes exactly where the last left off — which is
 * what makes interrupted-rebuild resume (§4.3) work.
 */
export class ProjectionEngine<DB> {
  private readonly db: Kysely<DB>;
  private readonly registry: ProjectionRegistry<DB>;
  private readonly watermarks: WatermarkStore;
  private readonly makeRebuildStore: (handle: Kysely<DB>) => RebuildStore;
  readonly invalidation: InvalidationBus;
  readonly stats: ProjectionStats;

  constructor(options: ProjectionEngineOptions<DB>) {
    this.db = options.db;
    this.registry = options.registry;
    this.watermarks = options.watermarks;
    this.makeRebuildStore = options.makeRebuildStore;
    this.invalidation = options.invalidation ?? new InvalidationBus();
    this.stats = options.stats ?? new ProjectionStats();
  }

  /** Read a module's watermarks (§4.3). */
  readWatermarks(moduleId: string): Promise<WatermarkState> {
    return this.watermarks.read(moduleId);
  }

  /**
   * Apply an own-device appended op (04 §5.1 step 6). Advances `applied_local_seq` to the op's
   * `seq` (strictly monotonic across appends). Bind this as the append path's projection seam
   * via {@link asAppendSeam}.
   */
  applyAppendedOp(op: ProjectionOperation): Promise<ApplyOutcome> {
    return this.applyOp(op, 'append');
  }

  /**
   * Apply a pulled (foreign) op. Advances `applied_server_seq` to the highest CONTIGUOUS
   * serverSeq now in the log (a gap pins it; the re-fold it may trigger moves it no further —
   * §4.3). The op must already be in the log with its `server_seq` set (the pull inserts first).
   */
  applyPulledOp(op: ProjectionOperation): Promise<ApplyOutcome> {
    return this.applyOp(op, 'pull');
  }

  /** The `ProjectionApply` seam for the append path (04 §5.1). */
  asAppendSeam(): ProjectionApply {
    return (op) => this.applyAppendedOp(op).then(() => undefined);
  }

  private async applyOp(op: ProjectionOperation, source: 'append' | 'pull'): Promise<ApplyOutcome> {
    const module = this.registry.moduleForType(op.type);
    if (module === undefined) {
      // No registered applier — defined no-op: nothing written, no watermark moved, no
      // invalidation. Version skew (05 §8 UNKNOWN_TYPE) surfaces elsewhere; the projection
      // simply does not reflect an op it cannot fold, with no partial write.
      this.stats.recordUnregistered();
      return { module: null, mode: 'unregistered', writtenTables: [] };
    }

    const entityTables = this.registry.tablesForEntityType(module, op.entityType);
    const outOfOrder = await hasNewerEntityOp(this.db, op);

    let mode: ApplyMode;
    if (!outOfOrder) {
      // HEAD: the op is the entity's canonical newest — apply incrementally.
      await this.applyWith(module, op);
      this.stats.recordHeadApply();
      mode = 'head';
    } else {
      // OUT-OF-ORDER: delete the entity's rows, re-fold its full history in canonical order.
      for (const ref of entityTables) {
        await sql`
          DELETE FROM ${sql.table(ref.table)} WHERE ${sql.ref(ref.entityIdColumn)} = ${op.entityId}
        `.execute(this.db);
      }
      const history = await readEntityOps(this.db, op.entityType, op.entityId);
      for (const historic of history) {
        await this.applyWith(module, historic);
      }
      this.stats.recordRefold();
      mode = 'refold';
    }

    if (source === 'append') {
      await this.watermarks.advanceLocalSeq(module.id, op.seq);
    } else {
      const current = await this.watermarks.read(module.id);
      const next = await highestContiguousServerSeq(this.db, current.appliedServerSeq);
      if (next > current.appliedServerSeq) {
        await this.watermarks.advanceServerSeq(module.id, next);
      }
    }

    const written = new Set(entityTables.map((ref) => ref.table));
    this.invalidation.emit(written);
    return { module: module.id, mode, writtenTables: [...written] };
  }

  /** Apply one op via its module's registered applier (guards a foreign type defensively). */
  private async applyWith(
    module: ModuleProjectionManifest<DB>,
    op: ProjectionOperation,
  ): Promise<void> {
    const applier = module.appliers[op.type];
    if (applier === undefined) return; // an entity op of a type this module does not fold
    await applier(this.db, op);
  }

  /** Run (or resume) a full rebuild of a module (04 §4.3). */
  rebuild(moduleId: string, options?: RunRebuildOptions): Promise<RebuildOutcome> {
    return runRebuild(
      {
        db: this.db,
        registry: this.registry,
        makeStore: this.makeRebuildStore,
        invalidation: this.invalidation,
        stats: this.stats,
      },
      moduleId,
      options,
    );
  }

  /**
   * Rebuild iff the module's projectionVersion signature changed since it was last recorded
   * (04 §4.3–4.4: a bump forces exactly one rebuild). Returns whether a rebuild ran.
   */
  async rebuildIfVersionChanged(
    moduleId: string,
    options?: RunRebuildOptions,
  ): Promise<{ readonly rebuilt: boolean; readonly outcome?: RebuildOutcome }> {
    const module = this.registry.module(moduleId);
    if (module === undefined) throw new Error(`unregistered module: ${moduleId}`);
    const store = this.makeRebuildStore(this.db);
    const stored = await store.readVersion(moduleId);
    const current = moduleVersionSignature(module);
    if (stored === current) return { rebuilt: false };
    const outcome = await this.rebuild(moduleId, options);
    return { rebuilt: true, outcome };
  }
}

/**
 * Convenience wiring for the CLIENT: an engine over `projection_watermarks` + `meta_kv`
 * (10-db §9.1). The server (task 16) constructs the engine with its own store implementations.
 */
export function createProjectionEngine<DB>(
  db: Kysely<DB>,
  registry: ProjectionRegistry<DB>,
  options?: { readonly invalidation?: InvalidationBus; readonly stats?: ProjectionStats },
): ProjectionEngine<DB> {
  return new ProjectionEngine<DB>({
    db,
    registry,
    watermarks: createSqlWatermarkStore(db),
    makeRebuildStore: (handle) => createSqlRebuildStore(handle),
    ...(options?.invalidation !== undefined ? { invalidation: options.invalidation } : {}),
    ...(options?.stats !== undefined ? { stats: options.stats } : {}),
  });
}
