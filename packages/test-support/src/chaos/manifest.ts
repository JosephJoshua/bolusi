// The GENERIC projection-manifest extractor (task 181): the projection-facing slice of ANY module
// (04 §4) — id, tables, and op-type → applier — the `ModuleProjectionManifest` the digest oracle
// (§3.4) and the projection engine consume. It reads `module.projections.tables` and the declared
// appliers straight off the shipped module, so there is no second copy of any module's schema
// (§2.8). It is domain-free: no `@bolusi/modules` import lives here (that would cycle — see seams.ts).
// The CONCRETE `notesProjectionManifest` is built by each caller from its own `notesModule` import
// (the harness's manifest shim; apps/mobile's device env) and handed in via `ConvergenceSeams`.
import type {
  AnyModuleDefinition,
  ModuleProjectionManifest,
  ProjectionApplier,
} from '@bolusi/core';

/** The projection-facing slice of a module (04 §4) — id, tables, and op-type → applier. */
export function toProjectionManifest<DB>(
  module: AnyModuleDefinition<DB>,
): ModuleProjectionManifest<DB> {
  const appliers: Record<string, ProjectionApplier<DB>> = {};
  for (const [type, declaration] of Object.entries(module.operations)) {
    appliers[type] = declaration.apply;
  }
  return { id: module.id, tables: module.projections.tables, appliers };
}
