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
// transactions (rebuild.ts), and needs nothing from an apply that runs between its batches.
//
// DELIVERY CONTRACT: each op is inserted into the op log immediately before its apply call, and
// ops are applied ONE AT A TIME (exactly the append seam's shape). Idempotent replay is the
// insert layer's job (05 §5: a duplicate `id` is not inserted, so apply is never called for it)
// — the engine's re-fold is inherently idempotent, and this contract keeps head-apply so too.
import type { Kysely } from 'kysely';

import type { ProjectionApply } from '../oplog/append.js';
import type { ModuleProjectionManifest, ProjectionOperation } from './manifest.js';
import { moduleVersionSignature } from './manifest.js';
import {
  hasNewerEntityOp,
  highestContiguousSeq,
  type FoldReadOptions,
  type OpSeqColumn,
} from './oplog-source.js';
import type { ProjectionRegistry } from './registry.js';
import {
  createSqlRebuildStore,
  refoldEntities,
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
  /**
   * Which op-log column the pull-path contiguity walk reads — `'arrival_seq'` on the client,
   * `'server_seq'` on the server (10-db §9.2's table; D20 §4). REQUIRED and never defaulted: the
   * two sides hold different numbers under different names, and a default would be correct on one
   * side and a silent decoy on the other. The two factories are the only places that answer it.
   */
  readonly seqColumn: OpSeqColumn;
  /**
   * Whether this log keeps ops the server refused: a device's does (they stay as chain links but
   * never fold), the server's never holds one. REQUIRED for the same reason as `seqColumn`.
   */
  readonly logKeepsRefusedOps: boolean;
  /** Factory so rebuild can bind the store to a batch transaction (rebuild.ts). */
  readonly makeRebuildStore: (handle: Kysely<DB>) => RebuildStore;
  /**
   * Leave the pull-path watermark to {@link ProjectionEngine.advancePulledWatermarks}, called once
   * after a batch, instead of advancing it after every op. The server's push sets this: its whole
   * batch is one transaction, so the watermark lands with the ops either way.
   */
  readonly batchPulledWatermarks?: boolean;
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
  private readonly seqColumn: OpSeqColumn;
  private readonly fold: FoldReadOptions;
  private readonly makeRebuildStore: (handle: Kysely<DB>) => RebuildStore;
  private readonly batchPulledWatermarks: boolean;
  /** Modules with pulled ops since the last {@link advancePulledWatermarks} (batch mode only). */
  private readonly pulledModules = new Set<string>();
  readonly invalidation: InvalidationBus;
  readonly stats: ProjectionStats;

  constructor(options: ProjectionEngineOptions<DB>) {
    this.db = options.db;
    this.registry = options.registry;
    this.watermarks = options.watermarks;
    this.seqColumn = options.seqColumn;
    this.fold = { skipRefused: options.logKeepsRefusedOps };
    this.makeRebuildStore = options.makeRebuildStore;
    this.batchPulledWatermarks = options.batchPulledWatermarks ?? false;
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
   * Apply a pulled (foreign) op. Advances `applied_server_seq` to the highest CONTIGUOUS value of
   * this engine's `seqColumn` now in the log (a gap pins it; the re-fold it may trigger moves it
   * no further — §4.3). The op must already be in the log with that column set — the client pull
   * assigns `arrival_seq`, the server push assigns `server_seq`, each before its own apply call.
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
      await refoldEntities(this.db, this.registry, module, op.entityType, [op.entityId], this.fold);
      this.stats.recordRefold();
      mode = 'refold';
    }

    if (source === 'append') {
      await this.watermarks.advanceLocalSeq(module.id, op.seq);
    } else if (this.batchPulledWatermarks) {
      this.pulledModules.add(module.id);
    } else {
      await this.advancePulledWatermark(module.id);
    }

    const written = new Set(entityTables.map((ref) => ref.table));
    this.invalidation.emit(written, { entityType: op.entityType, entityId: op.entityId });
    return { module: module.id, mode, writtenTables: [...written] };
  }

  /** Advance the watermark of every module a pulled op touched since the last call (batch mode). */
  async advancePulledWatermarks(): Promise<void> {
    for (const moduleId of this.pulledModules) await this.advancePulledWatermark(moduleId);
    this.pulledModules.clear();
  }

  private async advancePulledWatermark(moduleId: string): Promise<void> {
    const current = await this.watermarks.read(moduleId);
    const next = await highestContiguousSeq(this.db, current.appliedServerSeq, this.seqColumn);
    if (next > current.appliedServerSeq) {
      await this.watermarks.advanceServerSeq(moduleId, next);
    }
  }

  /**
   * Take an op the server refused back out of its record: re-fold the record from the ops that
   * still count (a refused op never folds, see `logKeepsRefusedOps`). Runs inside the caller's
   * transaction, the one that marks the op refused, so the two land together.
   */
  async refoldRefused(op: ProjectionOperation): Promise<void> {
    await this.refoldEntityOf(op);
  }

  /**
   * Re-fold the record `op` belongs to from its full log, inside the caller's transaction. For a
   * change that alters the record's history without being a new op: a refusal, or a re-enrolled
   * phone's unsynced changes moving to its new device.
   */
  async refoldEntityOf(op: ProjectionOperation): Promise<void> {
    const module = this.registry.moduleForType(op.type);
    if (module === undefined) return;
    await refoldEntities(this.db, this.registry, module, op.entityType, [op.entityId], this.fold);
    this.stats.recordRefold();
    const written = new Set(
      this.registry.tablesForEntityType(module, op.entityType).map((ref) => ref.table),
    );
    this.invalidation.emit(written, { entityType: op.entityType, entityId: op.entityId });
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
        fold: this.fold,
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
    if (stored === current && (await store.readCursor(moduleId)) === null)
      return { rebuilt: false };
    const outcome = await this.rebuild(moduleId, options);
    return { rebuilt: true, outcome };
  }

  /**
   * Rebuild every module whose projectionVersion changed, one batch at a time, calling `pause`
   * between batches (04 §4.4). The device runs this in the background after boot: the shop keeps
   * working while it runs (rebuild.ts), and the pause lets queued queries and the UI go first.
   * Stops early, resumable on the next boot, once `isStopped` answers true. Returns the modules
   * whose rebuild completed in this call.
   */
  async rebuildOutdated(options: {
    readonly pause: () => Promise<void>;
    readonly isStopped?: () => boolean;
    readonly batchSize?: number;
  }): Promise<string[]> {
    const rebuilt: string[] = [];
    const batch = {
      stopAfterBatches: 1,
      ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
    };
    for (const module of this.registry.modules()) {
      for (;;) {
        if (options.isStopped?.() === true) return rebuilt;
        const { rebuilt: ran, outcome } = await this.rebuildIfVersionChanged(module.id, batch);
        if (!ran) break;
        if (outcome?.complete === true) {
          rebuilt.push(module.id);
          break;
        }
        await options.pause();
      }
    }
    return rebuilt;
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
    // The CLIENT log numbers pulled ops with a local arrival counter (10-db §9.2, D20 §4) — the
    // server's `server_seq` column does not exist here, so a mis-wiring cannot be silent.
    seqColumn: 'arrival_seq',
    logKeepsRefusedOps: true,
    makeRebuildStore: (handle) => createSqlRebuildStore(handle),
    ...(options?.invalidation !== undefined ? { invalidation: options.invalidation } : {}),
    ...(options?.stats !== undefined ? { stats: options.stats } : {}),
  });
}
