// @bolusi/core projection engine (04-module-contract §4): applier registry, order-independent
// apply (head vs re-fold), watermarks, resumable rebuild, the convergence oracle, per-table
// live-query invalidation, and public dispatch counters. Platform-free; all effects go through
// an injected `ProjectionDb` (Kysely) + store ports (08 §3.2).
export type {
  ModuleProjectionManifest,
  ProjectionApplier,
  ProjectionColumnType,
  ProjectionDb,
  ProjectionOperation,
  ProjectionTableManifest,
} from './manifest.js';
export { declaredColumns, moduleVersionSignature } from './manifest.js';

export { ProjectionRegistry, ProjectionRegistryError, type EntityTableRef } from './registry.js';

export {
  cursorOf,
  hasNewerEntityOp,
  highestContiguousServerSeq,
  readCanonicalPage,
  readEntityOps,
  type CanonicalCursor,
} from './oplog-source.js';

// Exported for the SERVER side, not for this package's own convenience: any store reading an
// int8/bigint column needs this exact seam, and a package that cannot import it will write its own
// `Number(...)` instead — which is task 46 verbatim ("one function had the cast, the neighbour
// twelve lines away didn't"). Keeping the normaliser private would guarantee the copy (CLAUDE.md
// §2.8). Task 47's `createServerWatermarkStore` in @bolusi/db-server is the immediate consumer.
export { int8ToBigInt, int8ToNumber, type Int8Value } from './int8.js';

// The other two column classes with the same problem, exported for the same reason and NOT because
// this package needs them exported (task 48). A `jsonb` column reads back parsed on the server and
// as TEXT on the client; a `boolean` column reads back `false`/`true` server-side and `0`/`1`
// client-side. Any server store reading those columns needs these exact seams, and a package that
// cannot import them will write its own `JSON.parse(...)` or `!== 0` — which is how `payload` and
// `agent_initiated` broke in the first place, twelve lines apart, in one function.
export {
  boolColumnToBoolean,
  jsonColumnToObject,
  type BoolColumnValue,
  type JsonColumnValue,
} from './columns.js';

export {
  assertManifestColumnsComplete,
  digestModule,
  normalizeScalar,
  OracleError,
  type DbScalar,
  type HashFn,
} from './oracle.js';

export { createSqlWatermarkStore, type WatermarkState, type WatermarkStore } from './watermarks.js';

export {
  createSqlRebuildStore,
  DEFAULT_REBUILD_BATCH_SIZE,
  runRebuild,
  type RebuildCursorState,
  type RebuildOutcome,
  type RebuildStore,
  type RunRebuildContext,
  type RunRebuildOptions,
} from './rebuild.js';

export {
  InvalidationBus,
  type InvalidationListener,
  type TableInvalidationListener,
} from './invalidation.js';

export { ProjectionStats, type ProjectionStatsSnapshot } from './stats.js';

export {
  createProjectionEngine,
  ProjectionEngine,
  type ApplyMode,
  type ApplyOutcome,
  type ProjectionEngineOptions,
} from './engine.js';
